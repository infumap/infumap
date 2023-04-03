# CLI commands

## API Commands

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

## Admin Commands

### keygen

Generate an encryption key suitable for use with the `backup_encryption_key` settings property.

You generally you won't need to do this - a suitable (unique) key is generated when the settings.toml file first generated.

### migrate

Currently disabled (and not useful)

### repair

Work-in-progress. Command to reconcile the items in different object stores.

### restore

Unpack a backup file.
