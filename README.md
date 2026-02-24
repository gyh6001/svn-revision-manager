# SVN Revision Manager

Manage SVN revisions by organizing them into groups, viewing diffs, generating file lists, and more.

## Features

- Organize SVN revisions into groups
- View file diffs for specific revisions
- Generate consolidated file lists
- Lock/unlock files directly from VS Code
- Copy file names and paths
- Add Decorations for Locked, Modified, Unversioned, Ignored files in Explorer Tab
- Show lock owner + date time in the status bar
- **Optimized "Locked by others" loading** - lock details are fetched on demand to improve performance

## Requirements

- SVN command-line tool must be installed
- Access to an SVN repository

## Extension Settings

- `svnRevisionGroup.workingFolder`: Full path to your SVN working copy folder
- `svnRevisionGroup.svnPath`: Full path to svn.exe (default: "svn")
- `svnRevisionGroup.dataPath`: Custom path to store extension data

## Usage

1. Set your SVN working folder in settings
2. Open the SVN Revision Manager sidebar
3. Create groups and add revisions
4. Right-click files to lock/unlock
5. Right-click locked files and select **"Show Lock Info"** to view lock owner and date

## Lock Management

| Action | Description |
|--------|-------------|
| Lock File | Lock a file with an optional message |
| Force Lock | Steal a lock from another user |
| Unlock File | Release your lock on a file |
| Show Lock Info | View lock owner and creation date (for files locked by others) |

## Performance Notes

- The "Locked by me" section shows full lock details immediately
- The "Locked by others" section loads file names quickly without fetching details
- Use **"Show Lock Info"** to fetch lock owner/date on demand for better performance
