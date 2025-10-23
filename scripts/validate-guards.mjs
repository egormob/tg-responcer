#!/usr/bin/env node
import { execSync } from "node:child_process";
import { exit } from "node:process";

function run(command) {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

function unique(list) {
  return Array.from(new Set(list));
}

const diffTargets = [];
const baseRef = process.env.GITHUB_BASE_REF?.trim();
const guardBase = process.env.GUARD_BASE_REF?.trim();

if (baseRef) {
  diffTargets.push(`origin/${baseRef}`);
}
if (guardBase) {
  diffTargets.push(guardBase);
}

let changedFiles = [];
if (diffTargets.length > 0) {
  for (const target of diffTargets) {
    changedFiles = changedFiles.concat(run(`git diff --name-only ${target}...HEAD`));
  }
}

changedFiles = changedFiles
  .concat(run("git diff --name-only --cached"))
  .concat(run("git status --short" ).map((line) => line.slice(3)))
  .filter(Boolean);

changedFiles = unique(changedFiles);

const CORE_DIR = "apps/worker-main/core/";
const VERSION_FILE = `${CORE_DIR}VERSION`;

const coreChanges = changedFiles.filter(
  (file) => file.startsWith(CORE_DIR) && file !== VERSION_FILE
);

const versionChanged = changedFiles.includes(VERSION_FILE);

if (coreChanges.length > 0 && !versionChanged) {
  const message = [
    "Detected changes in core/ without updating core/VERSION.",
    "Changed files:",
    ...coreChanges.map((file) => ` - ${file}`),
    "Please bump apps/worker-main/core/VERSION in the same commit.",
  ].join("\n");
  console.error(message);
  exit(1);
}

exit(0);
