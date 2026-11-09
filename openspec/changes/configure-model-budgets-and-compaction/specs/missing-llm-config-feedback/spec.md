## ADDED Requirements

### Requirement: Budget and compaction configuration errors are reported as configuration errors

When the configured or derived context window, maximum output tokens, or compaction values are invalid or form a combination the runtime cannot use, the workspace SHALL classify the failure as a configuration error, SHALL show an actionable message in that cell's output area naming the conflicting values and the field to correct, and SHALL NOT send the request to the model.

#### Scenario: An invalid compaction combination blocks the run

- **WHEN** an AI cell is run while the effective budget produces a retain target that is not below the compaction threshold
- **THEN** the cell shows a configuration error that names the computed threshold and retain target
- **AND** no model turn is started

#### Scenario: An invalid ratio combination blocks the run

- **WHEN** an AI cell is run while the retain ratio is greater than or equal to the threshold ratio
- **THEN** the cell shows a configuration error naming both ratios
- **AND** no model turn is started

#### Scenario: Output budget exceeds the declared context window

- **WHEN** the effective maximum output tokens are greater than the declared context window
- **THEN** the cell reports a configuration error identifying both values
- **AND** the message directs the user to **Settings → AI Terminal**

#### Scenario: Correcting the budget allows a later run

- **WHEN** the user corrects the reported budget or compaction values and a shared runtime next starts normally
- **THEN** subsequent AI runs use the corrected active configuration and are handled normally
- **AND** the earlier configuration error is not retained as that run's result

### Requirement: Configuration guidance identifies the effective values and their source

The configuration message SHALL identify which budget or compaction values were user-provided, derived, or defaulted, and SHALL present the values actually evaluated, so the user can tell which input is responsible for the rejection. It MUST NOT echo or log the API token or any other credential.

#### Scenario: A derived default is responsible

- **WHEN** the rejection is caused by a derived or defaulted value rather than a user-entered one
- **THEN** the message identifies that value as derived or defaulted
- **AND** names the input it was derived from

#### Scenario: Secrets remain hidden

- **WHEN** a budget or compaction configuration error is displayed
- **THEN** the message contains no token or credential value

### Requirement: A patch-row preflight failure is reported as a configuration error

When the runtime's `--dump-config` preflight shows that a patched known row is missing or does not carry the expected fields, the system SHALL fail closed and report a configuration error in the cell output area that names the row id, instead of starting a session that silently runs without the configured budget or compaction. The message MUST NOT echo the API token or any other credential.

#### Scenario: A patched row is missing from the dumped configuration

- **WHEN** the generated patch references a `token-meter` or `compaction-basic` row the runtime does not apply
- **THEN** the shared runtime start is refused
- **AND** the cell shows a configuration error naming the row id
- **AND** no model turn is started with default budget or compaction settings

#### Scenario: A patched row lacks an expected field

- **WHEN** the dumped configuration contains the row but not a field the patch set
- **THEN** the shared runtime start is refused with an explicit error naming the row
- **AND** the effective configuration is not reported as applied
