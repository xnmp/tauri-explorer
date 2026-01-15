# Playwright UI Test Specification

This document specifies UI tests for the Tauri Explorer app. Run these periodically, not after every feature.

## Test Environment Setup

- App should be running at `http://localhost:1420` (Tauri dev server)
- Backend API at `http://localhost:8000`
- Create test directory structure before tests: `/tmp/explorer-test/`

---

## 1. Navigation Tests

### 1.1 Initial Load
- [ ] App loads without errors
- [ ] NavigationBar is visible
- [ ] Sidebar is visible with Quick Access section
- [ ] FileList shows home directory contents
- [ ] Breadcrumbs show current path

### 1.2 Folder Navigation
- [ ] Double-click on folder navigates into it
- [ ] Single-click on folder only selects it (does NOT navigate)
- [ ] Breadcrumb segments are clickable
- [ ] Clicking breadcrumb navigates to that path
- [ ] Back button works after navigation
- [ ] Forward button works after going back
- [ ] Up button navigates to parent directory

### 1.3 Path Bar
- [ ] Path bar shows current directory path
- [ ] Clicking path bar makes it editable (TODO: not yet implemented)
- [ ] Typing path and pressing Enter navigates to it
- [ ] Pressing Escape cancels path editing

---

## 2. Selection Tests

### 2.1 Single Selection
- [ ] Single-click on file selects it
- [ ] Selected file has visual highlight (border/background)
- [ ] Clicking another file changes selection
- [ ] Clicking empty space deselects all

### 2.2 Multi-Selection (TODO: not yet implemented)
- [ ] Ctrl+click adds to selection
- [ ] Shift+click selects range
- [ ] Ctrl+A selects all files

---

## 3. File Operations Tests

### 3.1 Open Files
- [ ] Double-click on file opens it in default app
- [ ] Files of different types open correctly (txt, png, pdf)

### 3.2 Context Menu
- [ ] Right-click on file shows context menu
- [ ] Right-click on empty space shows context menu (New folder only)
- [ ] Context menu has Cut, Copy, Rename, Delete options
- [ ] Context menu has New folder option
- [ ] Clicking outside context menu closes it
- [ ] Pressing Escape closes context menu

### 3.3 Cut/Copy/Paste
- [ ] Cut (Ctrl+X) marks file as cut (faded appearance)
- [ ] Copy (Ctrl+C) marks file as copied (badge shown)
- [ ] Paste (Ctrl+V) pastes file to current directory
- [ ] Clipboard banner shows copied/cut file name
- [ ] Clear clipboard button works

### 3.4 Rename
- [ ] F2 opens rename dialog
- [ ] Context menu Rename option works
- [ ] Rename dialog shows current name
- [ ] Typing new name and confirming renames file
- [ ] Cancel button closes dialog without renaming
- [ ] Invalid names show error

### 3.5 Delete
- [ ] Delete key opens delete confirmation
- [ ] Context menu Delete option works
- [ ] Confirmation dialog shows file name
- [ ] Confirm deletes file
- [ ] Cancel closes dialog without deleting

### 3.6 New Folder
- [ ] Context menu New folder opens dialog
- [ ] New folder dialog accepts name input
- [ ] Creating folder adds it to file list
- [ ] Duplicate name shows error

---

## 4. Sidebar Tests

### 4.1 Quick Access
- [ ] Quick Access section is visible
- [ ] Default bookmarks present (Documents, Downloads, Pictures, etc.)
- [ ] Clicking bookmark navigates to that directory
- [ ] Bookmarks use ~ expansion (not /home/user)

### 4.2 This PC (TODO: not yet implemented)
- [ ] This PC section shows drives
- [ ] Clicking drive navigates to it

---

## 5. View Tests

### 5.1 Details View
- [ ] Column headers visible (Name, Date modified, Type, Size)
- [ ] Clicking column header sorts by that column
- [ ] Sort indicator shows on active column
- [ ] Clicking again reverses sort order
- [ ] Folders shown with folder icon
- [ ] Files shown with file icon
- [ ] File sizes formatted correctly (KB, MB, GB)
- [ ] Dates formatted correctly

### 5.2 Hidden Files (TODO: not yet implemented)
- [ ] Hidden files not shown by default
- [ ] Ctrl+H toggles hidden files
- [ ] Hidden files appear faded when shown

---

## 6. Keyboard Shortcuts

### 6.1 Navigation
- [ ] F5 refreshes directory
- [ ] Backspace goes to parent (if implemented)
- [ ] Alt+Left goes back
- [ ] Alt+Right goes forward

### 6.2 File Operations
- [ ] Ctrl+C copies selected file
- [ ] Ctrl+X cuts selected file
- [ ] Ctrl+V pastes from clipboard
- [ ] F2 opens rename dialog
- [ ] Delete opens delete confirmation

### 6.3 Selection (TODO: not yet implemented)
- [ ] Ctrl+A selects all
- [ ] Arrow keys navigate selection
- [ ] Enter opens selected item

---

## 7. Error Handling Tests

### 7.1 Invalid Paths
- [ ] Navigating to non-existent path shows error
- [ ] Error message is clear and helpful
- [ ] App remains usable after error

### 7.2 Permission Errors
- [ ] Accessing restricted directory shows permission error
- [ ] Trying to delete protected file shows error

### 7.3 Network Errors
- [ ] Backend unavailable shows connection error
- [ ] App handles API timeout gracefully

---

## 8. Performance Tests

### 8.1 Large Directories
- [ ] Directory with 1000+ files loads within 2 seconds
- [ ] Scrolling through large list is smooth (>30 FPS)
- [ ] No UI freezing during load

### 8.2 Rapid Navigation
- [ ] Quickly navigating multiple folders doesn't cause issues
- [ ] Previous navigation requests are cancelled

---

## Test Data Setup

```bash
# Create test directory structure
mkdir -p /tmp/explorer-test/{folder1,folder2,folder3}
mkdir -p /tmp/explorer-test/folder1/{sub1,sub2}
touch /tmp/explorer-test/{file1.txt,file2.txt,image.png}
touch /tmp/explorer-test/folder1/{doc1.txt,doc2.txt}

# Create large directory for performance tests
mkdir -p /tmp/explorer-test/large
for i in {1..1000}; do touch /tmp/explorer-test/large/file$i.txt; done
```

---

## Running Tests

```bash
# Install Playwright
npm install -D @playwright/test

# Run all tests
npx playwright test

# Run specific test file
npx playwright test tests/navigation.spec.ts

# Run with UI
npx playwright test --ui

# Generate report
npx playwright show-report
```
