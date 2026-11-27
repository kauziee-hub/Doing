export interface LocalMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}
export interface LocalStatus {
  folder: string | null;
  busy: boolean;
  message: string;
  messages: LocalMessage[];
  changes: Array<{
    path: string;
    kind: 'created' | 'updated' | 'moved' | 'folder';
  }>;
  canUndo: boolean;
}
