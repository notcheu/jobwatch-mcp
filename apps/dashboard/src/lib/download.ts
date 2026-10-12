/** Hands a text to the browser as a file to save, under the given name. */
export function downloadText(fileName: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** The text of a file the person chose, or why it was not read. Looks at the size first, so a huge file is never loaded. */
export async function readTextFile(file: File, maxBytes: number): Promise<{ text: string } | { error: string }> {
  if (file.size > maxBytes) return { error: 'That file is too large to be an adapter.' };
  try {
    return { text: await file.text() };
  } catch {
    return { error: 'That file could not be read.' };
  }
}
