// The CLI, batch workers and Vite plugin run from dist/ (worker_threads load .js files), so build once first.
import { execFileSync } from "node:child_process";
export default function setup() {
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
}
