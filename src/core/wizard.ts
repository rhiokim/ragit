import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export const confirmStep = async (title: string, defaultYes = true): Promise<boolean> => {
  const hint = defaultYes ? "Y/n" : "y/N";
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${title} [${hint}] `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
    return defaultYes;
  } finally {
    rl.close();
  }
};

export const printStep = (index: number, total: number, message: string): void => {
  console.log(`[${index}/${total}] ${message}`);
};
