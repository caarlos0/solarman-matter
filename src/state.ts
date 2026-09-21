import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The inverter serial behind each logger address.
 *
 * The serial is the identity a Matter controller keeps, and it has to survive
 * an address that DHCP moved. The logger is powered by the inverter, so it is
 * gone every night and cannot be asked then; remembering the answer lets the
 * bridge publish its devices at any hour.
 */
export async function loadSerials(
  file: string,
): Promise<Map<string, string>> {
  try {
    const content = await readFile(file, "utf8");
    return new Map(Object.entries(JSON.parse(content) as Record<string, string>));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

export async function saveSerials(
  file: string,
  serials: Map<string, string>,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const asObject = Object.fromEntries([...serials].sort());
  await writeFile(file, `${JSON.stringify(asObject, null, 2)}\n`);
}
