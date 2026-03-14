# Playwright Test Scenarios
Issue: tauri-explorer-7ii

This document defines all UI test scenarios for the tauri-explorer application. These tests should be run by the ui-tester agent to verify the application works correctly.

## Test Setup

### Prerequisites
- Application must be running in development mode (`bun run tauri dev`)
- Test data directory with sample files and folders
- Browser: Chromium via Playwright

### Test Data Structure
```
test-data/
  documents/
    file1.txt
    file2.md
    image.png
  downloads/
    archive.zip
    video.mp4
  empty-folder/
  nested/
    level1/
      level2/
        deep-file.txt
```

---

## 1. Navigation Tests

### 1.1 Initial Load
- **Scenario**: App loads and displays home directory
- **Steps**:
  1. Launch application
  2. Wait for file list to appear
- **Expected**: Home directory contents visible, breadcrumbs show home path

### 1.2 Navigate to Folder (Double-Click)
- **Scenario**: Double-click folder to navigate into it
- **Steps**:
  1. Locate a folder in the file list
  2. Double-click the folder
- **Expected**: File list shows folder contents, breadcrumbs update

### 1.3 Navigate to Folder (Enter Key)
- **Scenario**: Select folder and press Enter
- **Steps**:
  1. Click a folder to select it
  2. Press Enter
- **Expected**: Navigate into folder

### 1.4 Navigate Back (Alt+Left or Back Button)
- **Scenario**: Go back to previous directory
- **Steps**:
  1. Navigate into a folder
  2. Press Alt+Left or click back button
- **Expected**: Return to previous directory

### 1.5 Navigate Up (Backspace or Up Button)
- **Scenario**: Go to parent directory
- **Steps**:
  1. Navigate into a nested folder
  2. Press Backspace or click up button
- **Expected**: Move to parent directory

### 1.6 Breadcrumb Navigation
- **Scenario**: Click breadcrumb segment to navigate
- **Steps**:
  1. Navigate deep into folder structure (e.g., /home/user/documents/nested)
  2. Click on an ancestor breadcrumb (e.g., "documents")
- **Expected**: Navigate to clicked path

### 1.7 Address Bar Navigation
- **Scenario**: Type path in address bar
- **Steps**:
  1. Click address bar (if editable)
  2. Type valid path
  3. Press Enter
- **Expected**: Navigate to typed path

---

## 2. File Selection Tests

### 2.1 Single Click Selection
- **Scenario**: Click file to select it
- **Steps**:
  1. Click on a file item
- **Expected**: File is highlighted as selected

### 2.2 Multi-Select with Ctrl+Click
- **Scenario**: Select multiple non-adjacent files
- **Steps**:
  1. Click first file
  2. Ctrl+Click on additional files
- **Expected**: Multiple files selected

### 2.3 Range Select with Shift+Click
- **Scenario**: Select range of files
- **Steps**:
  1. Click first file in range
  2. Shift+Click last file in range
- **Expected**: All files between first and last are selected

### 2.4 Select All (Ctrl+A)
- **Scenario**: Select all files in directory
- **Steps**:
  1. Press Ctrl+A
- **Expected**: All visible files selected

### 2.5 Deselect (Escape)
- **Scenario**: Clear selection
- **Steps**:
  1. Select one or more files
  2. Press Escape
- **Expected**: Selection cleared

### 2.6 Keyboard Navigation
- **Scenario**: Navigate selection with arrow keys
- **Steps**:
  1. Press Down arrow to select first item
  2. Continue pressing Down/Up arrows
- **Expected**: Selection moves through list

---

## 3. File Operations Tests

### 3.1 Create New Folder
- **Scenario**: Create folder via context menu or Ctrl+Shift+N
- **Steps**:
  1. Press Ctrl+Shift+N or right-click > New Folder
  2. Enter folder name in dialog
  3. Confirm
- **Expected**: New folder appears in list

### 3.2 Rename File (F2)
- **Scenario**: Rename selected file
- **Steps**:
  1. Select a file
  2. Press F2
  3. Enter new name
  4. Press Enter
- **Expected**: File renamed, list updates

### 3.3 Delete to Trash (Delete key)
- **Scenario**: Move file to trash
- **Steps**:
  1. Select file(s)
  2. Press Delete
  3. Confirm in dialog
- **Expected**: File removed from list (moved to trash)

### 3.4 Copy and Paste (Ctrl+C, Ctrl+V)
- **Scenario**: Copy file to another location
- **Steps**:
  1. Select file
  2. Press Ctrl+C
  3. Navigate to destination folder
  4. Press Ctrl+V
- **Expected**: File copied to destination

### 3.5 Cut and Paste (Ctrl+X, Ctrl+V)
- **Scenario**: Move file to another location
- **Steps**:
  1. Select file
  2. Press Ctrl+X
  3. Navigate to destination folder
  4. Press Ctrl+V
- **Expected**: File moved to destination (removed from source)

### 3.6 Open File (Enter or Double-Click)
- **Scenario**: Open file with default application
- **Steps**:
  1. Select a file
  2. Press Enter or double-click
- **Expected**: File opens in system default application

### 3.7 Undo Operation (Ctrl+Z)
- **Scenario**: Undo last file operation
- **Steps**:
  1. Perform a rename operation
  2. Press Ctrl+Z
- **Expected**: Rename is undone

---

## 4. Context Menu Tests

### 4.1 File Context Menu
- **Scenario**: Right-click on file shows context menu
- **Steps**:
  1. Right-click on a file
- **Expected**: Context menu appears with options: Open, Cut, Copy, Delete, Rename

### 4.2 Folder Context Menu
- **Scenario**: Right-click on folder shows context menu
- **Steps**:
  1. Right-click on a folder
- **Expected**: Context menu with: Open, Cut, Copy, Delete, Rename

### 4.3 Background Context Menu
- **Scenario**: Right-click on empty area
- **Steps**:
  1. Right-click on empty space in file list
- **Expected**: Context menu with: New Folder, Paste, Refresh

### 4.4 Multi-Select Context Menu
- **Scenario**: Right-click with multiple files selected
- **Steps**:
  1. Select multiple files
  2. Right-click on selection
- **Expected**: Context menu with bulk operations

---

## 5. View Mode Tests

### 5.1 Switch to Details View
- **Scenario**: Change to details/table view
- **Steps**:
  1. Click details view button in toolbar or use keyboard shortcut
- **Expected**: Files displayed in table with columns (Name, Size, Modified, etc.)

### 5.2 Switch to Tiles/Thumbnail View
- **Scenario**: Change to thumbnail/tiles view
- **Steps**:
  1. Click tiles view button
- **Expected**: Files displayed as thumbnails in grid

### 5.3 Switch to List View
- **Scenario**: Change to compact list view
- **Steps**:
  1. Click list view button
- **Expected**: Files displayed in compact list format

### 5.4 Sort by Column (Details View)
- **Scenario**: Click column header to sort
- **Steps**:
  1. Ensure details view is active
  2. Click "Name" column header
- **Expected**: Files sorted by name; click again reverses order

### 5.5 Toggle Hidden Files
- **Scenario**: Show/hide hidden files (Ctrl+H)
- **Steps**:
  1. Press Ctrl+H
- **Expected**: Hidden files (.dotfiles) toggle visibility

---

## 6. Tabs Tests

### 6.1 Create New Tab (Ctrl+T)
- **Scenario**: Open new tab
- **Steps**:
  1. Press Ctrl+T
- **Expected**: New tab opens showing home directory

### 6.2 Close Tab (Ctrl+W)
- **Scenario**: Close current tab
- **Steps**:
  1. Ensure multiple tabs open
  2. Press Ctrl+W
- **Expected**: Current tab closes, adjacent tab becomes active

### 6.3 Close Tab (Middle-Click)
- **Scenario**: Middle-click tab to close
- **Steps**:
  1. Middle-click on a tab
- **Expected**: Tab closes

### 6.4 Switch Tabs (Ctrl+Tab)
- **Scenario**: Cycle through tabs
- **Steps**:
  1. Open multiple tabs
  2. Press Ctrl+Tab
- **Expected**: Move to next tab

### 6.5 Switch Tabs (Ctrl+Shift+Tab)
- **Scenario**: Cycle backwards through tabs
- **Steps**:
  1. Press Ctrl+Shift+Tab
- **Expected**: Move to previous tab

### 6.6 Tab Shows Current Directory Name
- **Scenario**: Tab title reflects directory
- **Steps**:
  1. Navigate to a specific folder
- **Expected**: Tab title shows folder name

---

## 7. Dual Pane Tests

### 7.1 Toggle Dual Pane (Ctrl+\\)
- **Scenario**: Enable/disable dual pane view
- **Steps**:
  1. Press Ctrl+\
- **Expected**: Second pane appears/disappears

### 7.2 Switch Active Pane
- **Scenario**: Click to change active pane
- **Steps**:
  1. Enable dual pane
  2. Click in the non-active pane
- **Expected**: Clicked pane becomes active (visually indicated)

### 7.3 Independent Navigation
- **Scenario**: Each pane navigates independently
- **Steps**:
  1. Enable dual pane
  2. Navigate to folder A in left pane
  3. Click right pane
  4. Navigate to folder B in right pane
- **Expected**: Panes show different directories

---

## 8. Quick Open / Search Tests

### 8.1 Open Quick Open (Ctrl+P)
- **Scenario**: Open file search dialog
- **Steps**:
  1. Press Ctrl+P
- **Expected**: Quick open dialog appears with search input

### 8.2 Fuzzy Search Files
- **Scenario**: Search for file by partial name
- **Steps**:
  1. Open Quick Open
  2. Type partial filename (e.g., "doc" for "document.txt")
- **Expected**: Matching files shown in results

### 8.3 Navigate to Search Result
- **Scenario**: Select and open search result
- **Steps**:
  1. Search for file
  2. Use arrow keys to select result
  3. Press Enter
- **Expected**: File's parent folder opens with file selected, or file opens

### 8.4 Close Quick Open (Escape)
- **Scenario**: Dismiss quick open
- **Steps**:
  1. Open Quick Open
  2. Press Escape
- **Expected**: Dialog closes

---

## 9. Command Palette Tests

### 9.1 Open Command Palette (Ctrl+Shift+P)
- **Scenario**: Open command palette
- **Steps**:
  1. Press Ctrl+Shift+P
- **Expected**: Command palette dialog appears

### 9.2 Search Commands
- **Scenario**: Filter commands by typing
- **Steps**:
  1. Open Command Palette
  2. Type command name (e.g., "new folder")
- **Expected**: Matching commands filtered in list

### 9.3 Execute Command
- **Scenario**: Select and run command
- **Steps**:
  1. Search for command
  2. Press Enter or click command
- **Expected**: Command executes

### 9.4 Keyboard Navigation
- **Scenario**: Navigate commands with arrows
- **Steps**:
  1. Open Command Palette
  2. Press Up/Down arrows
  3. Press Enter
- **Expected**: Selection moves, command executes

---

## 10. Settings Tests

### 10.1 Open Settings (Ctrl+,)
- **Scenario**: Open settings dialog
- **Steps**:
  1. Press Ctrl+,
- **Expected**: Settings dialog opens

### 10.2 Toggle Theme
- **Scenario**: Switch between light/dark theme
- **Steps**:
  1. Open Settings
  2. Change theme setting
- **Expected**: UI theme changes immediately

### 10.3 Toggle Sidebar
- **Scenario**: Show/hide sidebar
- **Steps**:
  1. Find sidebar toggle in settings or use shortcut
- **Expected**: Sidebar visibility toggles

### 10.4 Toggle Toolbar
- **Scenario**: Show/hide toolbar
- **Steps**:
  1. Toggle toolbar setting
- **Expected**: Toolbar visibility toggles

---

## 11. Sidebar Tests

### 11.1 Quick Access Items
- **Scenario**: Click sidebar item to navigate
- **Steps**:
  1. Click "Documents" in sidebar
- **Expected**: Navigate to Documents folder

### 11.2 Bookmarks
- **Scenario**: Navigate to bookmarked location
- **Steps**:
  1. Click bookmark in sidebar
- **Expected**: Navigate to bookmarked path

### 11.3 Add Bookmark
- **Scenario**: Add current location to bookmarks
- **Steps**:
  1. Navigate to folder
  2. Use "Add Bookmark" command or button
- **Expected**: Folder added to bookmarks in sidebar

---

## 12. Keyboard Shortcuts Summary

| Shortcut | Action |
|----------|--------|
| Ctrl+T | New tab |
| Ctrl+W | Close tab |
| Ctrl+Tab | Next tab |
| Ctrl+Shift+Tab | Previous tab |
| Ctrl+P | Quick open |
| Ctrl+Shift+P | Command palette |
| Ctrl+, | Settings |
| Ctrl+\ | Toggle dual pane |
| Ctrl+A | Select all |
| Ctrl+C | Copy |
| Ctrl+X | Cut |
| Ctrl+V | Paste |
| Ctrl+Z | Undo |
| Ctrl+H | Toggle hidden files |
| Ctrl+Shift+N | New folder |
| F2 | Rename |
| Delete | Delete to trash |
| Enter | Open selected |
| Escape | Clear selection / Close dialog |
| Backspace | Navigate up |
| Alt+Left | Navigate back |
| Alt+Right | Navigate forward |

---

## 13. Error Handling Tests

### 13.1 Navigate to Invalid Path
- **Scenario**: Attempt to navigate to non-existent path
- **Steps**:
  1. Try to navigate to invalid path
- **Expected**: Error message displayed, stays in current directory

### 13.2 Permission Denied
- **Scenario**: Attempt to access restricted directory
- **Steps**:
  1. Try to navigate to system-protected folder
- **Expected**: Error message about permission denied

### 13.3 Delete Failure
- **Scenario**: Delete operation fails
- **Steps**:
  1. Try to delete file in use or protected
- **Expected**: Error message displayed

### 13.4 Rename to Existing Name
- **Scenario**: Rename file to name that already exists
- **Steps**:
  1. Select file
  2. Press F2
  3. Enter name of existing file
  4. Press Enter
- **Expected**: Error message about name conflict

---

## 14. Performance Smoke Tests

### 14.1 Large Directory Loading
- **Scenario**: Navigate to directory with 1000+ files
- **Steps**:
  1. Navigate to large directory
- **Expected**: Directory loads within 2 seconds, smooth scrolling

### 14.2 Rapid Navigation
- **Scenario**: Quickly navigate between folders
- **Steps**:
  1. Double-click folders in quick succession
- **Expected**: No UI freezing, navigation responsive

### 14.3 Search Performance
- **Scenario**: Search in large directory
- **Steps**:
  1. Open Quick Open in large directory tree
  2. Type search query
- **Expected**: Results appear within 500ms

---

## Test Execution Notes

### Running Tests
```bash
# Run all Playwright tests
bun run test:e2e

# Run specific test file
bun run test:e2e -- tests/e2e/navigation.spec.ts

# Run with headed browser (visible)
bun run test:e2e -- --headed

# Run with UI mode for debugging
bun run test:e2e -- --ui
```

### Test Isolation
- Each test should start from a clean state
- Use beforeEach to navigate to test data directory
- Clean up any created files/folders in afterEach

### Waiting Strategies
- Prefer waiting for specific UI elements over arbitrary delays
- Use `page.waitForSelector()` for elements to appear
- Use `page.waitForResponse()` for network operations
