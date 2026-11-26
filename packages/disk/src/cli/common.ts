import { Option, type Command } from "./command.js";
import { spinner } from "./spinner.js";
import {
  validateCredentialAndResolveRegion,
  type CredentialValidationOptions,
} from "./credential-validation.js";
import {
  deleteProfileCredential,
  promptSecret,
  rememberCredentialChoice,
  resolveCliCredentials,
  validateApiKey,
  writeProfileCredential,
  type CredentialFlags,
  type ResolvedCredentials,
} from "./credentials.js";
import { renderTable } from "./output.js";
import { deleteProfile, loadProfiles, profileEndpoint, profileRegions, saveProfiles } from "./profiles.js";

/** The global options' values, whether typed or taken from their environment variables. */
export type CliGlobalOptions = CredentialFlags;
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

/** The global credential options typed on the command line, leaving out values from environment variables. */
export function credentialFlags(program: Command): CredentialFlags {
  const options = program.opts<CredentialFlags>();
  const typed = (name: keyof CredentialFlags) => program.getOptionValueSource(name) === "cli" ? options[name] : undefined;
  return { apiKey: typed("apiKey"), region: typed("region"), baseUrl: typed("baseUrl"), profile: typed("profile") };
}

export async function resolveProgramCredentials(program: Command): Promise<ResolvedCredentials> {
  const credentials = await resolveCliCredentials(credentialFlags(program), await loadProfiles());
  rememberCredentialChoice(credentials);
  return credentials;
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

  outputOption(profiles.command("create").description("Create a named profile, or add a region to one"))
    .action(async (options: { output: ProfileOutput }) => {
      const global = program.opts<CliGlobalOptions>();
      const config = await loadProfiles();
      const existing = global.profile ? config.profiles[global.profile] : undefined;
      const alreadyHas = (region: string) => new Error(`Profile '${global.profile}' already exists and has a key for ${region}`);
      if (existing && global.region && profileEndpoint(existing, global.region)) throw alreadyHas(global.region);
      const apiKey = validateApiKey(credentialFlags(program).apiKey ?? await promptSecret());
      const progress = !global.region && !global.baseUrl && process.stderr.isTTY
        ? spinner(process.stderr)
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

      if (existing) {
        if (profileEndpoint(existing, region)) throw alreadyHas(region);
        const name = global.profile!;
        await writeProfileCredential(name, apiKey, undefined, region);
        existing.regions = { ...existing.regions, [region]: { baseUrl: global.baseUrl } };
        config.currentProfile = name;
        await saveProfiles(config);
        if (options.output === "json") console.log(JSON.stringify({ name, region, baseUrl: global.baseUrl, regions: profileRegions(existing), current: true }, null, 2));
        else console.log(`Added ${region} to profile '${name}'`);
        return;
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
          regions: profileRegions(profile),
          ...(profile.account ? { account: profile.account } : {}),
          current: config.currentProfile === name,
        }));
      if (options.output === "json") console.log(JSON.stringify(items, null, 2));
      else if (options.output === "text") {
        for (const item of items) console.log(`${item.current ? "*" : " "} ${item.name}\t${item.region}\t${item.baseUrl ?? "default"}\t${item.regions.join(",")}`);
      } else {
        console.log(renderTable(
          items.map((item) => [item.current ? "*" : "", item.name, item.region, item.baseUrl ?? "default", item.regions.join(", ")]),
          ["current", "name", "region", "base URL", "regions"],
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
