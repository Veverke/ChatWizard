# ChatWizard Architecture Diagram

## Overview
ChatWizard is a VS Code extension that indexes and visualizes chat sessions from multiple AI coding assistants (GitHub Copilot, Claude Code, Cline, Roo Code, Cursor, Windsurf, Aider).

## Component Architecture

### 1. Core Entry Point
```
src/extension.ts
├── Main activation function
├── VS Code extension registration
├── Webview panel serializers
├── Command registrations
├── Event listeners setup
└── File watcher initialization
```

### 2. Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                        │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│  │   Extension.ts  │  │   Webview Panels │  │   Commands      │   │
│  │                 │  │                 │  │                 │   │
│  │ • Entry point   │  │ • Session View  │  │ • Export        │   │
│  │ • Commands      │  │ • Analytics     │  │ • Search        │   │
│  │ • Listeners     │  │ • Code Blocks   │  │ • Manage WS     │   │
│  │ • Watcher init  │  │ • Prompt Lib    │  │ • Timeline      │   │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Core Services Layer                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│  │   SessionIndex  │  │   FileWatcher   │  │   WorkspaceScope│   │
│  │                 │  │                 │  │                 │   │
│  │ • Session CRUD  │  │ • File system   │  │ • Scope mgmt    │   │
│  │ • Change events │  │ • Live updates  │  │ • Persistence   │   │
│  │ • Search API    │  │ • Path discovery│  │ • Workspace IDs │   │
│  │ • Code blocks   │  │ • Security      │  │                 │   │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Parser & Reader Layer                        │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│  │   Parsers/      │  │   Readers/      │  │   Config Paths  │   │
│  │   Extractors    │  │   Discoverers   │  │                 │   │
│  │                 │  │                 │  │ • Claude path   │   │
│  │ • Claude JSONL  │  │ • Copilot WS    │  │ • Copilot path  │   │
│  │ • Copilot JSONL │  │ • Claude WS     │  │ • Cline path    │   │
│  │ • Cline JSON    │  │ • Cline tasks   │  │ • Cursor path   │   │
│  │ • Cursor DB     │  │ • Cursor WS     │  │ • Windsurf path │   │
│  │ • Windsurf DB   │  │ • Windsurf WS   │  │ • Aider roots   │   │
│  │ • Aider MD      │  │ • Aider files   │  │                 │   │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Search & Analysis Layer                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│  │   FullText      │  │   CodeBlock     │  │   Analytics     │   │
│  │   Search Engine │  │   Search Engine │  │   Engine        │   │
│  │                 │  │                 │  │                 │   │
│  │ • Inverted index│  │ • Code block    │  │ • Session stats │   │
│  │ • Tokenization  │  │ • Language      │  │ • Model usage   │   │
│  │ • Regex search  │  │ • Content search│  │ • Token counts  │   │
│  │ • Pagination    │  │ • Pagination    │  │ • Timeline      │   │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    View & UI Layer                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│  │   Tree Providers│  │   Webview Views │  │   Panels        │   │
│  │                 │  │                 │  │                 │   │
│  │ • Session Tree  │  │ • Session View  │  │ • Analytics     │   │
│  │ • Code Block    │  │ • Search Results│  │ • Code Blocks   │   │
│  │ • Prompt Library│  │ • Prompt Library│  │ • Prompt Library│   │
│  │ • Timeline      │  │ • Timeline      │  │ • Timeline      │   │
│  │ • Sort/Filter   │  │ • Export        │  │ • Export        │   │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    File System & Storage                        │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│  │   Session Files │  │   Config Files  │  │   Cache Files   │   │
│  │                 │  │                 │  │                 │   │
│  │ • .jsonl files  │  │ • settings.json │  │ • Index cache   │   │
│  │ • .md files     │  │ • workspace.json│  │ • Render cache  │   │
│  │ • .vscdb files  │  │ • .aider.conf   │  │ • Search cache  │   │
│  │ • .yml files    │  │ • .gitignore    │  │ • Token cache   │   │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow Patterns

### 1. Session Indexing Flow
```
File System Events → FileWatcher → Parser → SessionIndex → View Updates
```

### 2. Search Flow
```
User Input → Search Engine → Inverted Index → Results → Webview Display
```

### 3. View Rendering Flow
```
Session Data → Tree Provider → VS Code Tree → User Interaction → Webview Panel
```

## Key Interfaces

### Session Data Model
```typescript
interface Session {
  id: string;
  title: string;
  source: SessionSource;
  workspaceId: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  parseErrors?: string[];
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  codeBlocks: CodeBlock[];
  timestamp?: string;
}
```

### Core Services
```typescript
class SessionIndex {
  upsert(session: Session): void;
  remove(sessionId: string): boolean;
  batchUpsert(sessions: Session[]): void;
  search(query: string): SessionSummary[];
  getAllCodeBlocks(): IndexedCodeBlock[];
}

class FullTextSearchEngine {
  index(session: Session): void;
  search(query: SearchQuery): SearchResponse;
  remove(sessionId: string): void;
}
```

## Security Features

### 1. Path Traversal Protection
- Symlink resolution validation
- Base directory containment checks
- Safe file path verification

### 2. Input Validation
- Regex pattern length limits
- ReDoS attack prevention
- Token length restrictions

### 3. Configuration Security
- Per-source enable/disable settings
- Workspace scope filtering
- File size limits

## Extension Points

### 1. New AI Assistant Support
- Add parser in `src/parsers/`
- Add reader in `src/readers/`
- Update `SessionSource` type
- Register in `extension.ts`

### 2. New View Types
- Implement `TreeDataProvider`
- Create webview panel
- Add command registration
- Update UI integration

### 3. Search Enhancements
- Extend `SearchQuery` interface
- Add search algorithms
- Update search engine
- Update webview communication

## Performance Optimizations

### 1. Lazy Loading
- Incremental session indexing
- On-demand message rendering
- Virtualized tree views
- Pagination support

### 2. Caching Strategies
- Session render cache
- Search result cache
- Token index cache
- Code block cache

### 3. Background Processing
- Async file discovery
- Non-blocking parsing
- SetImmediate streaming
- Progress indicators

## Testing Architecture

### 1. Unit Tests
- Parser tests in `test/suite/*Parser.test.ts`
- Engine tests in `test/suite/*Engine.test.ts`
- Provider tests in `test/suite/*Provider.test.ts`

### 2. Integration Tests
- End-to-end workflow tests
- File system interaction tests
- Webview communication tests

### 3. Test Fixtures
- Sample session files in `test/fixtures/`
- Malformed data for error handling
- Edge cases for robustness

This architecture provides a scalable, secure, and extensible foundation for managing AI chat sessions across multiple coding assistants.