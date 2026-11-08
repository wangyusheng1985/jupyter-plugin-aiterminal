# File Browser Workspace Creation Specification

## Purpose

Allow users to create and enter a new AI Terminal workspace directly from the JupyterLab file browser while preserving the folder context in which they are working.

## Requirements

### Requirement: File browser context menu exposes AI Terminal creation

When the AI Terminal extension is active with JupyterLab's default file browser available, the file browser context menu SHALL include an **AI Terminal** creation action with the product's terminal icon and translated label.

#### Scenario: Context menu opens in the file browser

- **WHEN** the user opens the context menu within the default file browser's directory listing
- **THEN** an **AI Terminal** creation action is available in that menu

#### Scenario: File browser integration is unavailable

- **WHEN** the extension is activated in a JupyterLab environment without the optional default file browser service
- **THEN** activation succeeds without registering the file-browser context-menu action
- **AND** the existing Launcher action remains available

### Requirement: Context-menu creation respects the invoked directory

The context-menu action SHALL create an untitled `.agentnb` workspace in the directory represented by the invocation context. A targeted directory item SHALL take precedence; otherwise the current file browser directory SHALL be used.

#### Scenario: User invokes the action on a directory

- **WHEN** the user opens the file browser context menu on a directory item and chooses **AI Terminal**
- **THEN** a new untitled `.agentnb` workspace is created inside that directory

#### Scenario: User invokes the action in the current directory listing

- **WHEN** the user opens the file browser context menu without targeting a directory item and chooses **AI Terminal**
- **THEN** a new untitled `.agentnb` workspace is created in the file browser's current directory

#### Scenario: Default untitled name already exists

- **WHEN** the target directory already contains the default untitled `.agentnb` name
- **THEN** the new workspace uses JupyterLab's next available collision-free untitled name
- **AND** no existing file is overwritten

### Requirement: Context-menu creation opens the new workspace

After successful creation, the system SHALL open the new `.agentnb` document with the Agent Workspace document type and activate its tab, matching the existing Launcher creation experience.

#### Scenario: Workspace creation succeeds

- **WHEN** the file browser successfully creates the untitled `.agentnb` document
- **THEN** the document opens as an AI Terminal workspace
- **AND** its tab becomes the active main-area tab

#### Scenario: Launcher creation remains compatible

- **WHEN** the user creates AI Terminal from the Launcher instead of the file browser context menu
- **THEN** the existing behavior creates the workspace in the file browser's current directory and activates its tab
