export interface KeyStroke {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export type WorkspaceSurface = 'notebook';
export type EditorMode = 'command' | 'edit';

export interface KeyContext {
  running?: boolean;
  hasSelection?: boolean;
}

export type KeyAction =
  | { type: 'interrupt' }
  | { type: 'enter-edit' }
  | { type: 'exit-edit' }
  | { type: 'insert-above' }
  | { type: 'insert-below' }
  | { type: 'delete-chord' }
  | { type: 'run-advance' }
  | { type: 'run-stay' };

export function mapWorkspaceKey(
  stroke: KeyStroke,
  surface: WorkspaceSurface,
  editorMode: EditorMode,
  fromEditor = false,
  context: KeyContext = {}
): KeyAction | null {
  const modified = stroke.ctrlKey || stroke.metaKey;
  const letter =
    stroke.key.length === 1 ? stroke.key.toLowerCase() : stroke.key;

  if (modified && letter === 'c') {
    if (stroke.shiftKey) {
      return { type: 'interrupt' };
    }
    if (context.running && !context.hasSelection) {
      return { type: 'interrupt' };
    }
    return null;
  }
  if (modified && (letter === 'v' || letter === 'x' || letter === 'a')) {
    return null;
  }

  if (surface !== 'notebook') {
    return null;
  }
  if (editorMode === 'command') {
    if (
      stroke.key === 'Enter' &&
      !stroke.shiftKey &&
      !stroke.ctrlKey &&
      !stroke.metaKey
    ) {
      return { type: 'enter-edit' };
    }
    if (fromEditor || modified || stroke.shiftKey) {
      return null;
    }
    if (letter === 'a') {
      return { type: 'insert-above' };
    }
    if (letter === 'b') {
      return { type: 'insert-below' };
    }
    if (letter === 'd') {
      return { type: 'delete-chord' };
    }
    return null;
  }
  if (stroke.key === 'Escape') {
    return { type: 'exit-edit' };
  }
  if (stroke.key === 'Enter' && stroke.shiftKey) {
    return { type: 'run-advance' };
  }
  if (stroke.key === 'Enter' && (stroke.ctrlKey || stroke.metaKey)) {
    return { type: 'run-stay' };
  }
  return null;
}

export function strokeFromEvent(event: KeyboardEvent): KeyStroke {
  return {
    key: event.key,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey
  };
}
