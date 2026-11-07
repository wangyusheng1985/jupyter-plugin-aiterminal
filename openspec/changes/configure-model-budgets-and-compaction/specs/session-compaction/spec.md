## Purpose

Let users enable, disable, and tune the context compaction the runtime already provides, using values that are valid under the runtime's real budget formulas and load-time invariants, apply those values when the shared runtime next starts, and report compaction state honestly given the capabilities of the connected runtime.

## ADDED Requirements

### Requirement: Compaction behavior is configurable through settings

AI Terminal settings SHALL accept an optional automatic compaction switch and optional compaction parameters: a threshold ratio, a headroom token count, a retain ratio, and a summary output token budget. When a parameter is absent, the system SHALL apply a documented default and SHALL report that value's source. The system SHALL drive the runtime's existing compaction facility rather than implementing a second compaction mechanism.

#### Scenario: User disables automatic compaction

- **WHEN** the compaction switch is disabled in settings
- **THEN** the shared runtime runs without automatic compaction when it next starts
- **AND** the effective configuration reports compaction as disabled and attributes that choice to the user

#### Scenario: User supplies compaction parameters

- **WHEN** the settings file supplies a threshold ratio, headroom, retain ratio, and summary output budget
- **THEN** those values become the desired configuration and are applied when the shared runtime next starts
- **AND** the effective configuration reports each value as user-provided

#### Scenario: Compaction parameters are absent

- **WHEN** an existing settings file contains no compaction parameters
- **THEN** parsing succeeds using documented derived defaults
- **AND** the effective configuration identifies those defaults as derived rather than user-provided

### Requirement: Budget and compaction values are jointly validated against the runtime formulas

Before applying a configuration, the system SHALL evaluate the compaction values together with the effective context window and effective maximum output tokens using the runtime's own formulas: a message budget equal to the context window minus the maximum output tokens, a pressure value equal to that message budget minus the headroom, a threshold equal to the floor of the minimum of the context window times the threshold ratio and the pressure value, and a retain target equal to the floor of the message budget times the retain ratio. The system MUST reject a configuration the runtime would reject or would warn about and continue with, including non-positive budgets, a threshold ratio outside `(0, 1]`, a retain ratio outside `(0, 1]`, a retain ratio that is not strictly below the threshold ratio, negative headroom, a non-positive pressure value, and a retain target that is not strictly below the computed threshold.

#### Scenario: Retain ratio is not below the threshold ratio

- **WHEN** the retain ratio is greater than or equal to the threshold ratio
- **THEN** the configuration is rejected with an error naming both ratios
- **AND** no session is started with that configuration, even if the computed retain target happens to remain below the threshold

#### Scenario: Retain target is not below the threshold

- **WHEN** the computed retain target is greater than or equal to the computed threshold
- **THEN** the configuration is rejected with an error naming the two computed values
- **AND** no session is started with that configuration

#### Scenario: A ratio is outside its accepted range

- **WHEN** the threshold ratio or the retain ratio is zero, negative, or greater than one
- **THEN** the configuration is rejected with an error naming the field and the accepted range
- **AND** no session is started with that configuration

#### Scenario: Headroom exceeds the available budget

- **WHEN** the headroom is greater than or equal to the context window minus the maximum output tokens, so the pressure value is not positive
- **THEN** the configuration is rejected as unusable
- **AND** the error explains that the headroom leaves no room for compaction to trigger

#### Scenario: A previously accepted combination becomes invalid

- **WHEN** the effective context window and maximum output tokens make an existing compaction configuration invalid
- **THEN** the combined configuration is reported as a configuration error
- **AND** the system does not silently accept the runtime's warn-and-continue behavior as a working configuration

#### Scenario: A valid combination is accepted

- **WHEN** every compaction value is in range, the retain ratio is below the threshold ratio, and a strictly positive message budget and pressure produce a retain target below the threshold
- **THEN** the configuration is accepted
- **AND** the computed message budget, pressure, threshold, and retain target are available for display

### Requirement: Defaults are derived from the configured budget

Default headroom and default summary output budget SHALL be derived from the effective context window and maximum output tokens so that the resulting compaction configuration is valid. The system MUST NOT inherit a fixed headroom or summary output budget that exceeds the configured context window, and MUST NOT declare an output-token count that exceeds the configured maximum output tokens as a summary budget.

#### Scenario: A small configured context window

- **WHEN** the effective context window is small relative to a fixed headroom used elsewhere in the runtime
- **THEN** the derived headroom leaves a positive message budget and a positive pressure value
- **AND** the configuration is accepted rather than adopting the oversized fixed headroom

#### Scenario: Summary budget follows the output budget

- **WHEN** the summary output budget is not supplied by the user
- **THEN** the derived value does not exceed the effective maximum output tokens
- **AND** the effective configuration reports the derived value and its derivation source

### Requirement: Legacy configurations are migrated or rejected explicitly

A settings file written before this capability SHALL keep loading. When its combination of budget and compaction values cannot work under the runtime formulas or load-time invariants, the system SHALL NOT continue with a configuration that can never compact, that violates a ratio invariant, or that exceeds the declared context window; it SHALL either derive a valid replacement that is shown to the user, or report an actionable configuration error describing the invalid pair. The system MUST NOT report an invalid combination as a healthy configuration.

#### Scenario: Legacy settings with an oversized headroom

- **WHEN** settings from an earlier version imply a headroom larger than the available context budget
- **THEN** the resulting effective configuration is either a derived valid one shown to the user or an explicit error naming the conflicting values
- **AND** the system does not present that combination as valid

#### Scenario: Legacy settings remain loadable

- **WHEN** a settings file has no compaction fields at all
- **THEN** all existing connection fields still parse successfully
- **AND** the resulting compaction defaults are reported as derived

### Requirement: Compaction state is reported honestly within runtime capability

The system SHALL report compaction status only from evidence the connected runtime actually provides. When the connected protocol exposes no compaction-specific status update, the system SHALL present compaction as unavailable or unknown and MUST NOT fabricate a compaction event, a compaction count, or a claim that compaction was observed. The implementation SHALL verify the pinned remote runtime version before asserting any compaction observability.

#### Scenario: The runtime reports no compaction-specific update

- **WHEN** the runtime provides usage information but no compaction-specific status
- **THEN** the workspace reports compaction state as not observable
- **AND** the presentation does not claim that a compaction occurred

#### Scenario: Compaction observability is claimed

- **WHEN** an implementation claims to observe compaction
- **THEN** the claim is backed by a runtime capability verified against the pinned runtime version
- **AND** the workspace labels unsupported cases as a capability limit rather than an absence of compaction

### Requirement: Compaction preserves session identity and runtime boundaries

Compaction SHALL occur inside the existing ACP session without replacing that session, restarting the shared runtime, or affecting any other concurrent session. Enabling, disabling, or tuning compaction MUST NOT alter the saved session link of a workspace and MUST NOT restart, kill, or replace the shared runtime or interrupt an active/detached turn.

#### Scenario: Compaction occurs during a long turn

- **WHEN** the runtime compacts context while a turn is running
- **THEN** the same ACP session continues the turn
- **AND** the workspace's saved session link is unchanged
- **AND** other sessions on the shared runtime are unaffected

#### Scenario: Compaction settings change while sessions are live

- **WHEN** compaction settings are changed while a shared runtime and one or more sessions are running
- **THEN** running sessions keep their existing compaction behavior
- **AND** the change is marked `pending-next-runtime` and applies only when the shared runtime next starts
- **AND** the plugin does not restart or replace the runtime to apply it

#### Scenario: Compaction is not a context reset

- **WHEN** compaction has occurred
- **THEN** the workspace does not report that the runtime context was reset or that history was discarded by user action
