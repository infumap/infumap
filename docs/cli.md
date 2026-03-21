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
- **-s --settings (optional):** Path to a toml settings configuration file, or a directory containing `settings.toml`. If not specified and the `env_only` config value is not defined via an environment variable, `~/.infumap/settings.toml` will be used (and auto-created if it doesn't exist).
- **--dev (optional):** Enable experimental in-development features.

### keygen

Generate a 256 bit encryption key suitable for use with the `backup_encryption_key` configuration property or the `objectEncryptionKey` user item property.

Changing the `objectEncryptionKey` user property is currently not a supported / implemented feature.

A (unique) backup encryption key is generated when a new `settings.toml` file is auto-generated. Generally, you won't need to use the `keygen` command unless you are specifying configuration via environment variables, or creating a settings file from scratch.


### migrate

Migrate an existing user or item log file to the next version. This may be required when upgrading to a new version of Infumap. Ultimately log migration will happen automatically on web server startup and this command will be an advanced feature, however this is not implemented yet.

Options:
- **-p --log-path:** The path to the user or item log file to migrate to the next version.


### reconcile

Use this command to check / reconcile the contents of the configured object stores and item database. Generally, these
should stay in sync, however deviations can occur in some error scenarios, or if you manually modify the contents of the
Infumap data directory or object stores. There are two subcommands `missing` and `orphaned`:

#### missing sub-command

Identify files that are present in the source object store but not the destination. By default, files are just listed. If the --copy flag is specified, they are copied from source to destination.

- **-s --settings (optional):** Path to the settings file. If not specified, `~/.infumap/settings.toml` will be assumed.
- **-a --a (required):** The source object store.
- **-b --b (required):** The destination object store.
- **-c --copy (optional):** If specified, items present in the source but not destination object store will be copied to the destination. Else, they will just be listed.

Examples:

List all files in `s3_1` that are not present in `s3_2`:

```
infumap reconcile missing -a s3_1 -b s3_2
```

Copy all files in `s3_2` that are not present in the `local` object store to the `local` object store:

```
infumap reconcile missing -a s3_1 -b local --copy
```

#### orphaned sub-command

List object files in an object store that have no counterpart in the item database. TODO: options to remove or get these files.

- **-s --settings (optional):** Path to the settings file. If not specified, `~/.infumap/settings.toml` will be assumed.
- **-o --o (required):** The object store to check.

Examples:

List all files in `s3_2` that have no corresponding entry in the item database.

```
infumap reconcile orphaned -o s3_2
```


### restore

Decrypt / unpack a user backup file. A backup file includes the `user.json` and `items.json` log files. These will be output to the current directory, and you need to move them manually into the relevant user folder in the configured Infumap data directory.

Options:
- **-b --backup-file (required):** Path to the backup file.
- **-k --key (required):** The encryption key used to encrypt the data, specified in the configuration for the instance that created the backup file.


### emergency

Automates pulling the latest backup file for a specific user and preparing a recovery directory
based on this, in a user-specified directory. Use this command in the event there is a problem with your server that you can't resolve quickly
and you need to urgently access information in Infumap. This command is also useful as simple a disaster
recovery test. Since there are a lot of parameters, it's a good idea to have a simple shell script set up so
that you can act quickly if/when the time comes. This command does not start the web server; after setup, run:
`infumap web --settings <directory>`.

- **--s3-backup-endpoint:** As per your Infumap settings.
- **--s3-backup-region:** As per your Infumap settings.
- **--s3-backup-bucket:** As per your Infumap settings.
- **--s3-backup-key:** As per your Infumap settings.
- **--s3-backup-secret:** As per your Infumap settings.
- **--s3-endpoint (optional):** As per your Infumap settings.
- **--s3-region (optional):** As per your Infumap settings.
- **--s3-bucket (optional):** As per your Infumap settings.
- **--s3-key (optional):** As per your Infumap settings.
- **--s3-secret (optional):** As per your Infumap settings.
- **--user-id:** The user id to retrieve the backup file for.
- **--encryption-key:** As per your Infumap settings.
- **--recovery-dir:** Directory where `settings.toml`, `data`, and `cache` should be created/updated.
- **--port (optional):** Port to write into generated `settings.toml` (default: 8042).
- **--enable-backup (optional):** Enable backup to S3 in generated `settings.toml`. You will need to manually restore the backup using the `restore` command to use it with your main instance.
- **--backup-period-minutes (optional):** Backup period in minutes to write into generated `settings.toml` (default: 1).
- **--dev (optional):** Enable experimental in-development features.


### compact

Compact a user's item database log. Chronological order is not maintained. In the future, this operation will be handled
automatically, but for now if you want to compact a log, you must do it explicitly. After creating the compacted log,
you need to delete or move the original and replace it with the compacted version.

Options:

- **-i --id:** The user id.
- **-s --settings (optional):** Path to a toml settings configuration file. If not specified and the `env_only` config value is not defined via an environment variable, `~/.infumap/settings.toml` will be used (and auto-created if it doesn't exist).

### extract

Extract derived artifacts from PDFs or images without starting the web server.
This command has two subcommands:

- `extract pdf`
- `extract image`

Both subcommands load items, initialize the configured object store, and then either run a finite batch or a continuous background loop.
In both modes, Infumap keeps only one extraction/tagging request in flight at a time, while pipelining the next source-object read from object storage in the background.

### extract pdf

Run the text extraction processing loop for PDFs.

Options:

- **-s --settings (optional):** Path to a toml settings configuration file. If not specified, `~/.infumap/settings.toml` will be assumed.
- **--service-url (optional):** Override the configured `text_extraction_url` for this process.
- **--delay-secs (optional):** Sleep for this many seconds after each text extraction request in this process. Defaults to `0`.
- **--item-id (optional):** Extract text only for this item. The item must be a PDF. Existing extraction artifacts are overwritten.
- **--container-id (optional):** Extract text only for PDFs within this container subtree, then exit after the finite batch completes. By default, items with existing extraction artifacts are skipped.
- **--overwrite (optional):** When used with `--container-id`, reprocess items even if extraction artifacts already exist. `--item-id` always overwrites.
- **--list-failed (optional):** List PDFs for which text extraction previously failed, then exit. When combined with `--container-id`, only failures within that subtree are shown.
- **--mark-failed-item-id (optional, repeatable):** Write a failed text-extraction manifest for this PDF and exit without contacting the extraction service. This keeps the item from being retried until you explicitly reprocess it.
- **--mark-failed-reason (optional):** Reason string to store in manifests written via `--mark-failed-item-id`.
- **--delete-all (optional):** Delete all derived PDF text-extraction results while leaving image-tagging results untouched. Requires exactly one of `--dry-run` or `--force`.
- **--dry-run (optional):** Show which PDF text-extraction results `--delete-all` would remove without deleting anything.
- **--force (optional):** Perform the deletion requested by `--delete-all`.

### extract image

Run the image tagging processing loop for supported images.

Options:

- **-s --settings (optional):** Path to a toml settings configuration file. If not specified, `~/.infumap/settings.toml` will be assumed.
- **--service-url (optional):** Override the configured `image_tagging_url` for this process.
- **--delay-secs (optional):** Sleep for this many seconds after each image tagging request in this process. Defaults to `0`.
- **--item-id (optional):** Tag only this item. The item must have a supported image MIME type. Existing image-tag artifacts are overwritten.
- **--container-id (optional):** Tag only supported images within this container subtree, then exit after the finite batch completes. By default, items with existing image-tag artifacts are skipped.
- **--overwrite (optional):** When used with `--container-id`, reprocess items even if image-tag artifacts already exist. `--item-id` always overwrites.
- **--list-failed (optional):** List supported images for which image tagging previously failed, then exit. When combined with `--container-id`, only failures within that subtree are shown.
- **--mark-failed-item-id (optional, repeatable):** Write a failed image-tagging manifest for this image and exit without contacting the image tagging service. This keeps the item from being retried until you explicitly reprocess it.
- **--mark-failed-reason (optional):** Reason string to store in manifests written via `--mark-failed-item-id`.
- **--delete-all (optional):** Delete all derived image-tagging results while leaving PDF text-extraction results untouched. Requires exactly one of `--dry-run` or `--force`.
- **--dry-run (optional):** Show which image-tagging results `--delete-all` would remove without deleting anything.
- **--force (optional):** Perform the deletion requested by `--delete-all`.

### fragments

Build on-disk RAG fragment artifacts without starting the web server. The initial implementation writes fragments from the item `title` field only. This includes note text, since notes store their text in `title`.

Options:

- **-s --settings (optional):** Path to a toml settings configuration file. If not specified, `~/.infumap/settings.toml` will be assumed.
- **--item-id (optional):** Build fragments only for this item.

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


### ls

List the children and attachments of an item.

Options:
- **-s --session (optional):** The session name. If no session name is specified, "`default`" will be assumed.
- **-i --id (optional):** The item id. If omitted, the root container of the session user will be assumed.

Tip: You might find the console ctrl-w "kill last word" command useful when executing this command multiple times in a row.


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


### pending

List or approve pending users

Options:
- **-s --session (optional):** The session name. If no session name is specified, "`default`" will be assumed.

#### list sub-command

Lists all pending users


#### approve sub-command

Options:
- **-u --username (required):** The username of the pending user to approve.
