import { toastSuccess, toastError } from "@/lib/logger";

/** Copy text to the clipboard; `label` names what was copied in a success toast. */
export async function copyToClipboard(text: string, label?: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    if (label) toastSuccess(`Copied ${label}`);
  } catch (e) {
    toastError(`Failed to copy: ${e}`);
  }
}
