## Purpose

Let users configure and understand the provider budget that governs how much context the model may use and how many output tokens one turn may produce, and make the desired configuration, the shared runtime's active snapshot, its provenance, and budget-exhaustion outcomes observable instead of hidden constants.

## ADDED Requirements

### Requirement: Advanced budget settings are configurable

AI Terminal settings SHALL accept an optional context window and an optional maximum output token budget alongside the existing protocol, base URL, model, and token fields. When a budget field is absent, the system SHALL apply its documented default and SHALL report that the value came from a default rather than from the user. The settings schema SHALL continue to reject unknown keys.

#### Scenario: User supplies both budget values

- **WHEN** the settings file contains a context window and a maximum output token value
- **THEN** both values form the desired budget and become the active budget when the shared runtime next starts
- **AND** both values are reported as user-provided

#### Scenario: Budget fields are absent

- **WHEN** an existing settings file contains only the protocol, base URL, model, and token
- **THEN** parsing succeeds using the documented default budget
- **AND** the effective configuration reports those values as defaults, not as user choices

#### Scenario: An unknown key is present

- **WHEN** the settings file contains a budget-related key the plugin does not define
- **THEN** the settings schema rejects the key instead of ignoring it

#### Scenario: Budget value is not a positive integer

- **WHEN** a budget field is negative, zero, or not an integer
- **THEN** the system raises a configuration error naming the field
- **AND** no model turn is attempted with that configuration

### Requirement: The output budget is not silently clamped

The effective maximum output token value SHALL be the value derived from the configured budget. The system MUST NOT reduce the user-configured or provider-declared maximum output tokens to an unrelated fixed cap without reporting it. This change introduces no second, narrower budget cap: the value reported as effective is the value written to the provider row and the ACP profile.

#### Scenario: Configured output budget exceeds the previous fixed cap

- **WHEN** the configured or derived maximum output tokens are greater than the previously applied fixed cap
- **THEN** the applied provider budget uses the larger configured value
- **AND** the previously applied cap does not silently override it

#### Scenario: No other clamp exists

- **WHEN** the effective maximum output tokens are derived solely from the configured budget
- **THEN** the value written to the provider patch and the ACP profile equals the reported effective value
- **AND** no additional fixed or derived cap is applied

### Requirement: The effective configuration distinguishes desired and active snapshots

The workspace SHALL present the desired configuration from the current settings, the active configuration snapshot loaded by the shared runtime, their differences, and the runtime generation. When the desired configuration differs from the active snapshot, the workspace SHALL mark it `pending-next-runtime`. The active snapshot SHALL be the one recorded by the shared runtime from its first prepared transport, and reconnects or new sessions on that runtime SHALL continue to use it.

#### Scenario: Desired configuration differs from the active snapshot

- **WHEN** the settings file changes while a shared runtime is running
- **THEN** the workspace shows the new desired values
- **AND** shows the unchanged active values and generation
- **AND** marks the desired values `pending-next-runtime`

#### Scenario: The runtime restarts normally

- **WHEN** a shared runtime process next starts normally
- **THEN** it loads the desired configuration as its active snapshot
- **AND** the runtime generation advances and the workspace reports the values as active

#### Scenario: A session reconnects or is created on the running runtime

- **WHEN** a new session is created or an existing session reconnects while the shared runtime is already running
- **THEN** it uses the active snapshot recorded from the first transport
- **AND** it does not apply the pending desired configuration

### Requirement: The effective configuration and its provenance are observable

The workspace SHALL present the effective context window, effective maximum output tokens, and the source of each value, distinguishing at least: user setting, default, derived from another value, and inherited from the runtime profile. The presentation SHALL state that the context window is declared configuration metadata and MUST NOT claim it is a measurement of any model's real capacity. It MUST NOT claim that raising the output budget repairs truncation produced by a gateway or provider outside this plugin.

#### Scenario: A user views the effective budget

- **WHEN** a workspace with a known configuration is opened
- **THEN** the effective context window, effective maximum output tokens, and each value's source are visible
- **AND** the declared context window is not described as a measured model capability
- **AND** no promise is made that a larger budget fixes gateway or provider truncation

#### Scenario: A value was derived rather than provided

- **WHEN** a budget value was derived from another configured value
- **THEN** the presentation identifies it as derived
- **AND** names the value it was derived from

### Requirement: Budget exhaustion is a reported outcome, not an empty success

When a turn ends because the model reached the output token budget, the system SHALL report the turn as a budget-limited termination with an explicit reason in the cell output area, and SHALL persist that reason with the turn so a reopened detached turn shows it. It SHALL NOT render the turn as a completed success whose body is empty, and it MUST NOT continue the turn automatically or replay the request to obtain more output.

#### Scenario: A turn stops at the output budget

- **WHEN** the runtime reports that the turn ended because the maximum output tokens were reached
- **THEN** the cell shows a terminal explanation that the output budget was exhausted
- **AND** any text produced before the stop remains visible
- **AND** no automatic continuation turn is started
- **AND** a reopened detached turn shows the same budget-exhausted reason

#### Scenario: A turn fails without assistant text

- **WHEN** a turn ends in a failed state and no assistant text was produced
- **THEN** the cell shows the reported failure reason instead of an empty body
- **AND** the failure is not presented as a successful completion

#### Scenario: A cancellation is distinguished from a failure

- **WHEN** a turn ends because it was cancelled
- **THEN** the cell reports cancellation as its own reason
- **AND** does not report it as a budget-exhausted or failed turn

### Requirement: Configuration changes take effect only at the next runtime start

A budget change SHALL become active only when a shared runtime process next starts normally. The system MUST NOT hot-reconfigure a running shared runtime, an already-running ACP session, or any other live session; MUST NOT restart, kill, or replace the runtime and MUST NOT start a second runtime; and SHALL communicate the `pending-next-runtime` boundary where the effective configuration is shown.

#### Scenario: Settings are changed while a runtime is running

- **WHEN** the user changes a budget setting while a shared runtime and its sessions are active
- **THEN** the active snapshot and generation are unchanged
- **AND** active and detached turns are not interrupted
- **AND** the change is marked `pending-next-runtime`

#### Scenario: A new session starts before the runtime restarts

- **WHEN** the user starts a new session on the already-running shared runtime after changing settings
- **THEN** the new session uses the active snapshot
- **AND** the pending configuration is not reported as applied

#### Scenario: The boundary is explained

- **WHEN** the effective configuration is presented
- **THEN** it states whether the shown values are active or `pending-next-runtime`
- **AND** states that activation requires the shared runtime to start normally again
