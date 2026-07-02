import { expect, test } from "bun:test";
import { printHelp } from "../packages/cli/src/commands/help";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  toString(): string {
    return this.chunks.join("");
  }
}

test("help: install 文案展示最简默认双装入口", () => {
  const stream = new MemoryStream();
  printHelp(stream as unknown as NodeJS.WriteStream);

  const help = stream.toString();
  expect(help).toContain("e2e-loop install");
  expect(help).toContain("缺省: both");
  expect(help).toContain("--hook-mode <local|cli|auto>");
  expect(help).toContain("默认 cli");
  expect(help).not.toContain("默认 local");
});
