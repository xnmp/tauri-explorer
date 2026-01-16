**High Level Requirements** 
* minimalistic
	* can be customized down to only what's listed here and nothing more. 
* highly polished - looks like windows explorer/files app on microsoft store
	* this project was inspired by just getting rid of the action bar on windows explorer. 
	* please mirror the style of explorer in windows 11 as much as possible without infringing on copyright.
* high performance
	* feels snappy, does not feel laggy

**Table stakes**
* bookmarks
* drag and drop
	* both from and into other apps (eg browser, upload dialogs)
* thumbnail view, detail view, list view 
	* sorting by a particular detail
	* sort persistence
* right click context menu - compress or extract 
* back button / up button 
* breadcrumbs like in explorer
* undo/redo (just hotkeys)
* minor things
	* hide / show hidden files and dot files
* progress bars for long operations, allowing to cancel

**Features** 
* dual pane
	* start with dual pane but multi pane in the future
* Tabs per pane, like vscode
* saved layouts / workspaces and access them like bookmarks 
* preview pane 
* customisable hotkeys, like an IDE
* command palette like in IDEs
* Ctrl + p like in vscode
	* fuzzy searches the folder, possible using fzf
	* searches the cwd
* paste text and pictures as new files

**Commands**
* open among recent files - another fuzzy search
* search in files - like ctrl + shift + f in vscode, uses ripgrep. 
* less important:
	* move/copy to the other pane

**Extra Standard Features found in existing Options**
* bulk rename

**Unnecessary Frills**
* open terminal here - and can pick the terminal app
* even a terminal pane like in vscode
* thumbnail size adjustment
* AI Rename 
* Miller view (personally hate it)
* AI integration (eg Rename all files in a folder based on their content, eg all the images that are just random hashes). Perhaps something like a Claude code panel. 

**Hotkeys/Commands**
* Move/copy to another pane
* bring up preview pane (spacebar)

**Extra info**
- There's an indy project called fileside which ticks all the boxes except customisable hotkeys, thumbnail view, and it has no back button. 
- I'm inspired by Vivaldi because it's so customisable and polished. 
