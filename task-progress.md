# Feature 28 & 29 UI Wiring

- [x] Analyze codebase — found all backend logic exists but UI wiring missing
- [ ] Add commands to package.json (setSessionStatus, filterByStatus, addBookmark, removeBookmark)
- [ ] Add context menu items for status and bookmark commands
- [ ] Add "Filter by Status" option in filter dialog (extension.ts)
- [ ] Pass status to SessionTreeItem and show status badge in tree
- [ ] Pass status to webview and render status chip in session reader
- [ ] Pass bookmarks to webview and add bookmark click handler
- [ ] Handle bookmarkUpdated message in webview JS
- [ ] Render bookmark jump list in webview
- [ ] Mark bookmarked messages visually in webview