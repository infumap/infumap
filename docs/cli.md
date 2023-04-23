# CLI commands

CLI commands are split into two categories:

- **Local**: These commands work directly with Infumap configuration and data. Generally, you should terminate the corresponding web server instance (if it is currently running) before using these commands.

- **API**: These commands operate against a running Infumap instance (started with the "web" command) via an HTTP API.


## Local Commands

### web

Start an Infumap web server. By default, configuration will be read from `~/.infumap/settings.toml`. If this file does not exist, it will be created automatically (by default). Also, suitable on-disk data directories will be automatically created in `~/.infumap` as required. In summary, to get a functional Infumap web instance up and running, it is not necessary do anything beyond simply executing `infumap web`.

In addition to (or instead of) using a settings file, Infumap web server configuration can be specified via environment variables. This approach is particularly useful in containerized deployment scenarios.

For more information on configuring the Infumap web server, refer to [configuration.md](configuration.md).


Options:
- **-s --settings (optional):** Path to a toml settings configuration file. If not specified and the `env_only` config value is not defined via an environment varable, `~/.infumap/settings.toml` will be used (and auto-created if it doesn't exist).

### keygen

Generate a 256 bit encryption key suitable for use with the `backup_encryption_key` configuration property or the `objectEncryptionKey` user item property.

Changing the `objectEncryptionKey` user property is currently not a supported / implemented feature.

A (unique) backup encryption key is generated when a new `settings.toml` file is auto-generated. Generally, you won't need to use the `keygen` command unless you are specifying configuration via environment variables, or creating a settings file from scratch.

### migrate

Migrate an existing user or item log file to the next version. This may be required when upgrading to a new version of Infumap. Ultimately log migration will happen automatically on web server startup and this command will be an advanced feature, however this is not implemented yet.

Options:
- **-p --log-path:** The path to the user or item log file to migrate to the next version.

### reconcile

Use this command to check / reconcile the contents of the configured object stores and item database.

Options:
- **-s --settings (optional):** Path to the settings file. If not specified, `~/.infumap/settings.toml` will be assumed.
- **-m --mode (required):** The sub command. Currently only "missing" is implemented (and only partially). In the future there will be a command "orphaned" for discovering object files that have no counterpart in the item database, and for deleting / retrieving them.
- **-a --a (required):** The source object store.
- **-b --b (required):** The destination object store.
- **-c --copy (optional):** Only valid in "missing" mode. If specified, items present in the source but not destination object store will be copied to the destination. Else, they will just be listed.

Examples:

Copy any files in the `s3_1` object store that are not present in the `s3_2` object store to `s3_2`:

```
infumap reconcile -m missing -a s3_1 -b s3_2 -c
```

Copy any files in the `s3_2` object store that are not present in the `local` object store to the `local` object store:

```
infumap reconcile -m missing -a s3_1 -b local -c
```


### restore

Decrypt / unpack a user backup file. A backup file includes the user.json and item.json log files. These will be output to the current directory, and you need to move them manually into the relevant user folder in the configured Infumap data directory.

Options:
- **-b --backup-file (required):** Path to the backup file.
- **-k --key (required):** The encryption key used to encrypt the data, specified in the configuration for the instance that created the backup file.


## API Commands

### login

Open a long-running session on an Infumap instance. An entry in `~/.infumap/cli/sessions.json` is added to keep track of the session.

An open session is required before using other CLI commands that communicate with a running web instance.

Sessions are named. If you don't specify a name, "`default`" will be assumed.

Options:
- **-s --session (optional):** The session name.

### logout

Closes an open session. If no session name is specified, "`default`" will be assumed.

Options:
- **-s --session (optional):** The session name.

### note

Add a note.

Options:
- **-s --session (optional):** The session name. If no session name is specified, "`default`" will be assumed.
- **-c --container-id (optional):** The id of the container to add the note to. If omitted, the note will be added to the root container of the session user.
- **-n --note (required):** The note to add. Should be in quotes (" ").

### upload

Bulk upload files or images (item type is auto detected) to an infumap container. This is more reliable / convenient than drag and drop for large numbers of files.

Options:
- **-s --session (optional):** The session name. If no session name is specified, "`default`" will be assumed.
- **-c --container-id (required):** The id of the container to add the files to.
- **-d --directory (required):** The path of the directory to upload all files from. This directory must only contain regular files (no links or directories).
- **-r --resume (optional):** By default, if the Infumap container has a file or image with the same name as a file in the local directory, the bulk upload operation will not start. If this flag is set, these files will be skipped instead.
- **-a --additional (optional):** By default, an attempt to upload files to an Infumap container that contains files with names other than those in the local directory will fail. Setting this flag disables this check.
