# CLI commands

The Infumap executable provides various commands. There are two categories:

- **Direct**: These commands work directly with Infumap configurtion and data. Your Infumap instance should be terminated before using these commands.
- **API**: These commands require an operating Infumap instance, and perform their work via a REST API exposed by this instance.


## Direct

### web

Starts the Infumap Web Server.

Optionally specify a settings file.

Settings can be specified via env vars.

Automatically creates a settings file and default config / data directories in ~/.infumap is no settings file is explicitly specified.

For more information refer to [configuration.md](configuration.md)

### keygen

Generate an encryption key suitable for use with the `backup_encryption_key` settings property.

You generally you won't need to do this - a suitable (unique) key is generated when the settings.toml file first generated.

### migrate

Currently disabled (and not useful)

### repair

Work-in-progress. Command to reconcile the items in different object stores.

### restore

Unpack a backup file.


## API Commands

This collection of commands operate by communicating with a running Infumap web server instance.

### login

Opens a session on an Infumap instance, keeping record of it in ~/.infumap/cli/sessions.json.

This is required before running other CLI commands that communicate with the instance API.

The default session name is "default".

The CLI can manage multiple open sessions using the -s flag.

### logout

Closes session on an Infumap instance.

### note

Add a note.

### upload

Bulk upload files.