# SVN Revision Manager

**SVN Revision Manager** is a Visual Studio Code extension designed to improve the workflow of developers working with Subversion (SVN).  
It provides an organized, group-based system for managing revisions, browsing changes, and generating file summaries—all directly within the VS Code interface.

This extension enhances productivity for teams maintaining legacy systems or large monolithic codebases where SVN remains the primary version control tool.

---

## Key Features

### • Group-Based Revision Management  
Organize SVN revisions into custom groups such as “Bug Fixes,” “Feature Modules,” or “Hotfixes” for structured tracking and review.

### • Add and Manage Revisions  
Add revisions into groups with automatic retrieval of commit messages and changed file lists.

### • File and Revision Diff Views  
- Double-click a revision to view the full patch.  
- Double-click a file to view the file-specific patch generated via `svn diff -c`.

### • Inline File Listings  
Expand a revision to view all changed files.  
Supports copying:
- File name only  
- Full relative file path  

### • Generate Deduplicated File Lists  
Right-click a group to produce a consolidated, deduplicated list of all files affected by revisions within the group.  
The result opens in a new text editor tab.

### • Editing and Cleanup Tools  
- Rename groups  
- Delete groups  
- Delete revisions  

### • Automatic Persistence  
All groups and revisions are saved using VS Code global storage and restored upon startup.

### • Icon Support  
Custom icons are provided for group nodes with compatibility for both light and dark themes.

### • Configurable Working Directory  
Specify your SVN working folder in VS Code Settings for accurate diff and log retrieval.

---

## Installation

### From VSIX (Local installation)

```sh
vsce package
