# SVN Revision Manager

Manage SVN revisions by organizing them into groups, viewing diffs, generating file lists, and more.

## Features

- Organize SVN revisions into groups
- View file diffs for specific revisions
- Generate consolidated file lists
- Lock/unlock files directly from VS Code
- Copy file names and paths
- Add Decorations for Locked, Modified, Unversioned, Ignored files in Explorer Tab

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
4. Right-click files to lock/unlock.
