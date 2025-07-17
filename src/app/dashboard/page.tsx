"use client";

import { useState, useMemo, useRef } from "react";
import Editor, { OnMount } from "@monaco-editor/react";
import type * as monaco from 'monaco-editor';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MongoQuillLogo } from "@/components/icons";
import { Database, Play, Loader2, Code2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { DB_CONTENT as INITIAL_DB_CONTENT, DB_CONFIG } from "@/lib/data";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type DbId = keyof typeof INITIAL_DB_CONTENT;

const DEFAULT_QUERY = `db.passengers.find({ 
  tier: "Solitaire PPS Club" 
})`;

// --- Query Execution Logic ---

function executeQuery(
  data: Record<string, any[]>,
  operation: ParsedQuery
): { collection: string; data: any; message?: string } {
    const collectionName = operation.collectionName;
    if (!data[collectionName] && operation.command !== 'find') {
      throw new Error(`Collection "${collectionName}" not found.`);
    }

    switch (operation.command) {
        case 'find': {
            if (!data[collectionName]) {
                throw new Error(`Collection "${collectionName}" not found.`);
            }
            let results = [...data[collectionName]];
            const filter = operation.args[0] || {};
            if (Object.keys(filter).length > 0) {
                results = results.filter(doc => evaluateFilter(doc, filter));
            }
            return { collection: collectionName, data: results };
        }
        case 'insertOne': {
            const doc = operation.args[0];
            if (!doc || typeof doc !== 'object') throw new Error('insertOne requires a document argument.');
            if (!data[collectionName]) data[collectionName] = [];
            data[collectionName].push({ _id: `new_${Date.now()}`, ...doc });
            return { collection: collectionName, data: { acknowledged: true, insertedId: `new_${Date.now()}` }, message: 'Document inserted.' };
        }
        case 'insertMany': {
             const docs = operation.args[0];
             if (!Array.isArray(docs)) throw new Error('insertMany requires an array of documents.');
             if (!data[collectionName]) data[collectionName] = [];
             const insertedIds = docs.map((doc, i) => `new_${Date.now()}_${i}`);
             docs.forEach((doc, i) => data[collectionName].push({ _id: insertedIds[i], ...doc }));
             return { collection: collectionName, data: { acknowledged: true, insertedIds }, message: `${docs.length} documents inserted.` };
        }
        case 'updateOne':
        case 'updateMany': {
            const filter = operation.args[0] || {};
            const update = operation.args[1] || {};
            if (Object.keys(update).length === 0) throw new Error('Update operator is required.');

            let modifiedCount = 0;
            const collectionData = data[collectionName];
            
            for (let i = 0; i < collectionData.length; i++) {
                if (evaluateFilter(collectionData[i], filter)) {
                    collectionData[i] = applyUpdate(collectionData[i], update);
                    modifiedCount++;
                    if (operation.command === 'updateOne') break;
                }
            }
            
            return { collection: collectionName, data: { acknowledged: true, modifiedCount, matchedCount: modifiedCount }, message: `${modifiedCount} document(s) updated.` };
        }
        case 'deleteOne':
        case 'deleteMany': {
            const filter = operation.args[0] || {};
            let deletedCount = 0;
            const initialCount = data[collectionName].length;

            const newData = data[collectionName].filter(doc => {
                const shouldDelete = evaluateFilter(doc, filter);
                if (shouldDelete) {
                    if (operation.command === 'deleteOne' && deletedCount === 0) {
                        deletedCount++;
                        return false;
                    }
                    if (operation.command === 'deleteMany') {
                       return false;
                    }
                }
                return true;
            });
            
            if (operation.command === 'deleteMany') {
                deletedCount = initialCount - newData.length;
            }

            data[collectionName] = newData;
            
            return { collection: collectionName, data: { acknowledged: true, deletedCount }, message: `${deletedCount} document(s) deleted.` };
        }
        default:
            throw new Error(`Unsupported command: ${operation.command}`);
    }
}

function applyUpdate(doc: any, update: any) {
    const newDoc = { ...doc };
    for (const op in update) {
        if (op === '$set') {
            for (const field in update.$set) {
                setNestedValue(newDoc, field, update.$set[field]);
            }
        } else if (op === '$unset') {
            for (const field in update.$unset) {
                deleteNestedValue(newDoc, field);
            }
        }
        // Add more update operators like $inc, $rename etc. here if needed
    }
    return newDoc;
}

function setNestedValue(obj: any, path: string, value: any) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (current[keys[i]] === undefined || typeof current[keys[i]] !== 'object') {
            current[keys[i]] = {};
        }
        current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
}

function deleteNestedValue(obj: any, path: string) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (current[keys[i]] === undefined) return;
        current = current[keys[i]];
    }
    delete current[keys[keys.length - 1]];
}


function evaluateFilter(doc: any, filter: any): boolean {
  if (!filter || typeof filter !== 'object') return true;
  const filterKeys = Object.keys(filter);

  if (filterKeys.includes('$and')) {
    if (!Array.isArray(filter.$and)) throw new Error('$and must be an array');
    return filter.$and.every((subFilter: any) => evaluateFilter(doc, subFilter));
  }

  if (filterKeys.includes('$or')) {
    if (!Array.isArray(filter.$or)) throw new Error('$or must be an array');
    return filter.$or.some((subFilter: any) => evaluateFilter(doc, subFilter));
  }
  
  if (filterKeys.includes('$not')) {
    if (typeof filter.$not !== 'object' || filter.$not === null) throw new Error('$not must be an object');
    return !evaluateFilter(doc, filter.$not);
  }

  return filterKeys.every(key => {
    // Top-level keys can't be operators
    if (key.startsWith('$')) {
        return true; // Or throw error, depending on strictness
    }

    const docValue = getNestedValue(doc, key);
    const filterValue = filter[key];

    if (typeof filterValue === 'object' && filterValue !== null && !Array.isArray(filterValue)) {
      const op = Object.keys(filterValue)[0];
       if (!op.startsWith('$')) {
         return JSON.stringify(docValue) === JSON.stringify(filterValue);
       }
      const val = filterValue[op];

      switch(op) {
        case '$gt': return docValue > val;
        case '$lt': return docValue < val;
        case '$gte': return docValue >= val;
        case '$lte': return docValue <= val;
        case '$ne': return docValue !== val;
        case '$in': 
          if (!Array.isArray(val)) throw new Error(`$in requires an array value.`);
          return val.includes(docValue);
        case '$nin':
          if (!Array.isArray(val)) throw new Error(`$nin requires an array value.`);
          return !val.includes(docValue);
        default:
           // Fallback for nested objects without operators
          return JSON.stringify(docValue) === JSON.stringify(filterValue);
      }
    }
    
    return docValue === filterValue;
  });
}

function getNestedValue(obj: any, path: string) {
  return path.split('.').reduce((acc, part) => acc && acc[part], obj);
}

// --- Query Parsing Logic ---

type SupportedCommand = 'find' | 'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany';
interface ParsedQuery {
    command: SupportedCommand;
    collectionName: string;
    args: any[];
}
const SUPPORTED_COMMANDS: SupportedCommand[] = ['find', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'];

function parseMongoQuery(queryString: string): ParsedQuery {
    const query = queryString.trim();
    
    // Improved regex to better handle empty arguments
    const commandRegex = new RegExp(`^db\\.([a-zA-Z0-9_-]+)\\.(${SUPPORTED_COMMANDS.join('|')})\\((.*)\\)$`, 's');
    const match = query.match(commandRegex);

    if (!match) {
        throw new Error('Invalid query format or unsupported command. Supported: ' + SUPPORTED_COMMANDS.join(', '));
    }

    const [, collectionName, command, argsString] = match;

    // Handle case where there are no arguments, e.g., db.collection.find()
    if (argsString.trim() === '') {
        return { command: command as SupportedCommand, collectionName, args: [] };
    }
  
    try {
        // This is a security risk in a real app, but for this simulation it's okay.
        // It allows parsing of JS objects, not just strict JSON.
        const args = new Function(`return [${argsString}]`)();
        return { command: command as SupportedCommand, collectionName, args };
    } catch (e) {
        console.error("Parsing Error:", e);
        throw new Error("Failed to parse query arguments. Ensure they are valid JavaScript objects/values.");
    }
}


export default function DashboardPage() {
  const [dbData, setDbData] = useState(INITIAL_DB_CONTENT);
  const [activeDb, setActiveDb] = useState<DbId | null>("singapore-airlines");
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [result, setResult] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeCollection, setActiveCollection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);


  const collections = useMemo(() => {
    if (!activeDb) return [];
    return Object.keys(dbData[activeDb]);
  }, [activeDb, dbData]);

  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  const handleSelectDb = (dbId: DbId) => {
    setActiveDb(dbId);
    setResult(null);
    const newDbCollections = Object.keys(INITIAL_DB_CONTENT[dbId]);
    const firstCollection = newDbCollections.length > 0 ? newDbCollections[0] : 'collection';
    setQuery(`db.${firstCollection}.find({})`);
    setActiveCollection(null);
    setError(null);
  };

  const handleRunQuery = () => {
    if (!activeDb || !editorRef.current) return;

    let queryToRun = query;
    const selection = editorRef.current.getSelection();
    if (selection && !selection.isEmpty()) {
      queryToRun = editorRef.current.getModel()?.getValueInRange(selection) || '';
    }
    
    if (!queryToRun.trim()) {
        setError("Query is empty.");
        return;
    }

    setIsLoading(true);
    setResult(null);
    setError(null);
    setActiveCollection(null);

    setTimeout(() => {
      try {
        const parsedOperation = parseMongoQuery(queryToRun);
        
        // Make a deep copy to mutate
        const currentDbData = JSON.parse(JSON.stringify(dbData[activeDb]));
        
        const { collection, data, message } = executeQuery(currentDbData, parsedOperation);
        
        // If it was a mutation, update the state
        if (['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'].includes(parsedOperation.command)) {
            setDbData(prev => ({
                ...prev,
                [activeDb]: currentDbData
            }));
        }

        setActiveCollection(collection);
        setResult(JSON.stringify(data, null, 2));

      } catch (e: any) {
        setError(e.message || "An unexpected error occurred.");
      } finally {
        setIsLoading(false);
      }
    }, 800);
  };

  return (
    <div className="flex h-screen bg-background text-foreground font-sans">
      {/* Left Panel: Database Selection */}
      <aside className="w-[280px] flex-shrink-0 bg-muted/30 border-r flex flex-col">
        <div className="p-4 border-b h-16 flex items-center gap-3">
          <MongoQuillLogo className="h-7 w-7 text-primary" />
          <h1 className="text-xl font-headline font-semibold">MongoQuill</h1>
        </div>
        <nav className="flex-1 p-4 space-y-2">
          <h2 className="px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Databases</h2>
          {DB_CONFIG.map((db) => (
            <Button
              key={db.id}
              variant={activeDb === db.id ? "secondary" : "ghost"}
              className={cn(
                "w-full justify-start h-11 text-base",
                activeDb === db.id && "font-bold"
              )}
              onClick={() => handleSelectDb(db.id as DbId)}
            >
              <Database className="mr-3 h-5 w-5" />
              {db.name}
            </Button>
          ))}
        </nav>
      </aside>

      {/* Right Panel: Editor and Results */}
      <main className="flex-1 flex flex-col">
        {!activeDb ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Select a database to begin.
          </div>
        ) : (
          <div className="flex flex-col flex-1 h-full">
            {/* Top half: Query Editor */}
            <div className="flex-1 flex flex-col border-b">
              <header className="p-4 flex justify-between items-center border-b flex-shrink-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-medium">{DB_CONFIG.find(db => db.id === activeDb)?.name}</h2>
                  <span className="text-sm text-muted-foreground">/</span>
                  <div className="flex items-center gap-2 flex-wrap">
                    {collections.map(name => (
                      <span key={name} className="text-sm text-muted-foreground">{name}</span>
                    ))}
                  </div>
                </div>
                <Button onClick={handleRunQuery} disabled={isLoading}>
                  {isLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="mr-2 h-4 w-4" />
                  )}
                  Run Query
                </Button>
              </header>
              <div className="flex-1 relative">
                <Editor
                  height="100%"
                  language="javascript"
                  theme="vs-dark"
                  value={query}
                  onMount={handleEditorDidMount}
                  onChange={(value) => setQuery(value || "")}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 16,
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    lineNumbers: 'off',
                    automaticLayout: true,
                    glyphMargin: false,
                    folding: false,
                    lineDecorationsWidth: 0,
                    lineNumbersMinChars: 0,
                    padding: {
                      top: 16,
                      bottom: 16,
                    },
                  }}
                />
              </div>
            </div>

            {/* Bottom half: Results */}
            <div className="flex-1 flex flex-col min-h-0">
              <header className="p-4 flex items-center gap-2 border-b flex-shrink-0">
                 <Code2 className="h-5 w-5" />
                 <h2 className="text-lg font-medium">Results</h2>
                 {activeCollection && <span className="text-sm text-muted-foreground">from &quot;{activeCollection}&quot; collection</span>}
              </header>
              <div className="flex-1 bg-muted/20 p-4 overflow-auto">
                {isLoading ? (
                  <div className="space-y-4">
                    <Skeleton className="h-6 w-1/4" />
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-4 w-3/4" />
                  </div>
                ) : error ? (
                   <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Query Error</AlertTitle>
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                ) : result ? (
                  <pre className="font-code text-sm"><code >{result}</code></pre>
                ) : (
                  <div className="text-muted-foreground h-full flex items-center justify-center">
                    Run a query to see the results here.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
