## Purpose

Give first-time users a clear, actionable explanation when an AI cell cannot run because the required LLM settings have not been configured or are incomplete.

## ADDED Requirements

### Requirement: AI execution reports missing LLM configuration clearly
When an AI cell is run and the Base URL, Model, or API Token configuration is missing, empty, invalid, or incomplete, the workspace SHALL show an actionable configuration message in that cell's output area.

#### Scenario: First AI run without a settings file
- **WHEN** the user runs an AI cell before configuring AI Terminal settings
- **THEN** the cell displays a configuration-specific error explaining that LLM settings are missing and directing the user to **Settings → AI Terminal**

#### Scenario: Incomplete LLM settings
- **WHEN** the user runs an AI cell with one or more required LLM fields empty or invalid
- **THEN** the cell identifies the configuration problem, names the required Base URL, Model, and API Token fields, and directs the user to **Settings → AI Terminal**

#### Scenario: Configuration error is visible in the output area
- **WHEN** the configuration error is returned for the current AI execution
- **THEN** the message is visible without requiring the user to inspect a server log or browser console

### Requirement: Configuration errors do not become model or shell execution failures
The system SHALL classify missing or invalid LLM settings as a configuration error, SHALL NOT attempt an Agent SDK model request for that run, and SHALL leave Command cell execution independent of the LLM configuration.

#### Scenario: Missing settings short-circuit an AI run
- **WHEN** an AI run is submitted without valid LLM settings
- **THEN** no model turn is started and the run ends with a configuration error message

#### Scenario: Command cell with missing LLM settings
- **WHEN** the user runs a Command cell while LLM settings are absent
- **THEN** the command executes through the local shell and no LLM configuration prompt is inserted into its output

### Requirement: Corrected settings allow a subsequent AI run
After the user fills the required LLM settings and opens a new AI Terminal WebSocket/session, a subsequent AI run SHALL be handled normally and SHALL not retain the prior configuration error as the current run's result.

#### Scenario: Retry after configuring settings
- **WHEN** the user configures Base URL, Model, and API Token, opens a new AI Terminal session, and runs an AI cell again
- **THEN** the workspace attempts the AI run and displays the returned response or runtime error instead of the missing-configuration prompt

### Requirement: Configuration guidance does not expose secrets
The configuration prompt SHALL name the required setting fields and navigation path but SHALL NOT echo or log the API token value.

#### Scenario: Existing token is present but another field is missing
- **WHEN** configuration validation reports an incomplete settings set
- **THEN** the visible guidance identifies the missing configuration category without displaying any token or credential value

