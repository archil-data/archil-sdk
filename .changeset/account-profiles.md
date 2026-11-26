---
"disk": minor
"archil": minor
---

CLI profiles are now accounts that hold an API key per region:

- `archil login` saves every region's key the console sends in one profile, named after the account (`Acme Inc` becomes `acme-inc`), and a later login for the same account replaces that profile's keys instead of adding another profile. `archil login --region R` asks the console to make R the default.
- `--region` picks which of the profile's regions a command uses. A region the profile has no key for is an error that says how to add it.
- Each command takes its key from exactly one source, with the region and base URL that belong to it: `--api-key`, then `--profile`, then `ARCHIL_API_KEY`, then `ARCHIL_PROFILE` or the current profile. An explicit `--profile` now beats `ARCHIL_API_KEY`, and a key is no longer combined with another source's region.
- `archil whoami` shows the region and where the key came from, and a rejected key's hint names that source.
- `profile create` prompts for the key unless `--api-key` is typed, rather than silently saving `ARCHIL_API_KEY`, and adds a region to an existing profile. `profile list` shows each profile's regions. `logout` and `profile delete` remove every region's key.
- `ssh-config` pins `--region` when it isn't the profile's default.
- The library honors `ARCHIL_BASE_URL` when the region comes from `ARCHIL_REGION`.

Existing profiles keep working, and older CLIs can still read profiles saved by this one (they see the default region).
