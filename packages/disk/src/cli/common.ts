import { spinner } from "@clack/prompts";
import type { Command } from "commander";
import { Option } from "commander";
import {
  validateCredentialAndResolveRegion,
  type CredentialValidationOptions,
} from "./credential-validation.js";
import {
  deleteProfileCredential,
  promptSecret,
  resolveCliCredentials,
  validateApiKey,
  writeProfileCredential,
  type ResolveCredentialOptions,
} from "./credentials.js";
import { renderTable } from "./output.js";
import { deleteProfile, loadProfiles, saveProfiles } from "./profiles.js";

export type CliGlobalOptions = ResolveCredentialOptions;
type ProfileOutput = "table" | "text" | "json";
export type ProfileCredentialValidator = (options: CredentialValidationOptions) => Promise<string>;

export function addGlobalOptions(program: Command): void {
  program
    .configureHelp({ showGlobalOptions: true })
    .addOption(new Option("-k, --api-key <key>", "Archil API key (prefer profiles, environment variables, or stdin)").env("ARCHIL_API_KEY"))
    .addOption(new Option("-r, --region <region>", "Archil region").env("ARCHIL_REGION"))
    .addOption(new Option("--base-url <url>", "Override control-plane base URL").env("ARCHIL_BASE_URL"))
    .addOption(new Option("--profile <name>", "Named Archil profile").env("ARCHIL_PROFILE"));
}

export function isProfileCommand(command: Command): boolean {
  return command.parent?.name() === "profile";
}

export async function resolveProgramCredentials(program: Command) {
  return resolveCliCredentials(program.opts<CliGlobalOptions>(), await loadProfiles());
}

export function addProfileCommands(
  program: Command,
  validateCredential: ProfileCredentialValidator = validateCredentialAndResolveRegion,
): void {
  const outputOption = (command: Command) => command.option(
    "-o, --output <format>",
    "Output format: table | text | json",
    (value: string): ProfileOutput => {
      if (value !== "table" && value !== "text" && value !== "json") throw new Error("Output format must be 'table', 'text', or 'json'");
      return value;
    },
    "table" as ProfileOutput,
  );
  const profiles = program.command("profile").description("Manage named Archil profiles and credentials");

  outputOption(profiles.command("create").description("Create a named profile"))
    .action(async (options: { output: ProfileOutput }) => {
      const global = program.opts<CliGlobalOptions>();
      const config = await loadProfiles();
      if (global.profile && config.profiles[global.profile]) {
        throw new Error(`Profile '${global.profile}' already exists`);
      }
      const apiKey = validateApiKey(global.apiKey ?? await promptSecret());
      const progress = !global.region && !global.baseUrl && process.stderr.isTTY
        ? spinner({ output: process.stderr, withGuide: false })
        : undefined;
      progress?.start("Finding the API key's region");
      let region: string;
      try {
        region = await validateCredential({
          apiKey,
          region: global.region,
          baseUrl: global.baseUrl,
        });
        progress?.stop("Found valid region");
      } catch (error) {
        progress?.error("No valid region found");
        throw error;
      }
      let name = global.profile ?? region;
      if (!global.profile) {
        let suffix = 2;
        while (config.profiles[name]) name = `${region}-${suffix++}`;
      }
      await writeProfileCredential(name, apiKey);
      config.profiles[name] = { region, baseUrl: global.baseUrl };
      config.currentProfile = name;
      await saveProfiles(config);
      if (options.output === "json") console.log(JSON.stringify({ name, region, baseUrl: global.baseUrl, current: true }, null, 2));
      else console.log(`Created profile '${name}' (${region})`);
    });

  outputOption(profiles.command("list").description("List profiles without revealing credentials"))
    .action(async (options: { output: ProfileOutput }) => {
      const config = await loadProfiles();
      const items = Object.entries(config.profiles)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, profile]) => ({
          name,
          region: profile.region,
          baseUrl: profile.baseUrl,
          current: config.currentProfile === name,
        }));
      if (options.output === "json") console.log(JSON.stringify(items, null, 2));
      else if (options.output === "text") {
        for (const item of items) console.log(`${item.current ? "*" : " "} ${item.name}\t${item.region}\t${item.baseUrl ?? "default"}`);
      } else {
        console.log(renderTable(
          items.map((item) => [item.current ? "*" : "", item.name, item.region, item.baseUrl ?? "default"]),
          ["current", "name", "region", "base URL"],
        ));
      }
    });

  outputOption(profiles.command("use <name>").description("Select the default profile"))
    .action(async (name: string, options: { output: ProfileOutput }) => {
      const config = await loadProfiles();
      if (!config.profiles[name]) throw new Error(`Profile '${name}' does not exist`);
      config.currentProfile = name;
      await saveProfiles(config);
      if (options.output === "json") console.log(JSON.stringify({ name, current: true }, null, 2));
      else console.log(`Using profile '${name}'`);
    });

  outputOption(profiles.command("delete <name>").description("Delete a profile and its stored credential"))
    .action(async (name: string, options: { output: ProfileOutput }) => {
      const config = await loadProfiles();
      if (!config.profiles[name]) throw new Error(`Profile '${name}' does not exist`);
      await deleteProfileCredential(name);
      await deleteProfile(name);
      if (options.output === "json") console.log(JSON.stringify({ name, deleted: true }, null, 2));
      else console.log(`Deleted profile '${name}'`);
    });
}
