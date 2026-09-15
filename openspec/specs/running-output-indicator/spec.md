# Running Output Indicator Specification

## Purpose

Provide an unobtrusive output-tail animation that makes ongoing AI and Command cell execution apparent without changing the cell's actual result.

## Requirements

### Requirement: Running cells display an animated output-tail indicator
The workspace SHALL display an animated three-dot indicator after the last visible output item of every expanded cell whose execution status is running, regardless of whether the cell is an AI cell or a Command cell.

#### Scenario: Running cell already has output
- **WHEN** a running cell has one or more visible output items
- **THEN** the animated three-dot indicator is displayed after the last visible output item

#### Scenario: Running cell has no output yet
- **WHEN** a cell starts running before any output item has been produced
- **THEN** the output area displays the animated three-dot indicator as its running placeholder

#### Scenario: Additional output arrives
- **WHEN** a running cell receives additional streamed output
- **THEN** the indicator remains positioned after the newest visible output item

### Requirement: The indicator follows the execution lifecycle
The workspace SHALL derive indicator visibility from the cell's current execution status and SHALL remove it when the cell is no longer running.

#### Scenario: Execution completes
- **WHEN** a running cell transitions to a completed state
- **THEN** the indicator is no longer displayed while the final output remains unchanged

#### Scenario: Execution is interrupted
- **WHEN** a running cell transitions to an interrupted state
- **THEN** the indicator is no longer displayed while output produced before interruption remains visible

### Requirement: The indicator does not become cell output
The workspace SHALL render the indicator as presentation-only state and SHALL NOT append its dots to the cell's output data, persisted document content, or copied result text.

#### Scenario: Running document is saved
- **WHEN** a document is persisted while its cell is displaying the indicator
- **THEN** the saved cell output excludes all indicator characters and animation state

#### Scenario: Output text is copied
- **WHEN** a user copies the output text of a running cell
- **THEN** the copied result excludes the indicator characters

### Requirement: Motion preference is respected
The workspace SHALL present the running indicator without continuous animation when the user's environment requests reduced motion.

#### Scenario: Reduced motion is enabled
- **WHEN** the cell is running and the user has enabled reduced motion
- **THEN** a static three-dot indicator is visible at the output tail

