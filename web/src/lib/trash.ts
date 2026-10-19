// Trash: "delete" moves a wish item to the trash (restorable for 30 days, then purged by a daily job).
import { supabase } from "./supabase.ts";
import { dataVersion, toast } from "./store.ts";

export const TRASH_DAYS = 30;

export async function restoreItem(id: string): Promise<boolean> {
  const { error } = await supabase.from("wish_items").update({ deleted_at: null }).eq("id", id);
  if (error) {
    toast(error.message);
    return false;
  }
  dataVersion.value++;
  return true;
}

/** Moves the item to the trash and offers an immediate undo. */
export async function moveToTrash(id: string, name: string): Promise<boolean> {
  const { error } = await supabase.from("wish_items").update({ deleted_at: new Date().toISOString() }).eq("id", id);
  if (error) {
    toast(error.message);
    return false;
  }
  dataVersion.value++;
  toast(`"${name}" siirretty roskakoriin`, {
    label: "Kumoa",
    run: async () => {
      if (await restoreItem(id)) toast(`"${name}" palautettu`);
    },
  });
  return true;
}
