# Kavita API notes

Behaviour of Kavita **v0.9.1.4** (linuxserver `v0.9.1.4-ls128`) that this project relies on, verified
against a live server. Re-check after upgrading Kavita. The full API description is in
`reference/kavita-openapi-v0.9.1.4.json` (from Kavita's repository; it says "built against v0.9.1.1").
Kavita's Swagger UI is only served in Development builds.

## Authentication

- `x-api-key: <auth key>` header, or `Authorization: Bearer <token>` from
  `POST /api/Account/login {username, password}`, which returns the user with `roles`, `token`, `refreshToken`.
- A user without the `Login` role gets 401 "Your account is disabled".
- `POST /api/Plugin/authenticate?apiKey=<key>&pluginName=<name>` signs in with a user's own key; it
  returns the right username and a token but **roles `[]` and id `0`**, so roles must be looked up in
  `GET /api/Users` (admin).
- `GET /api/Plugin/version?apiKey=<key>` returns 401 for an invalid key (cheap validity check).
- Session tokens (password or key sign-in) are JWTs valid for 72 hours, issued with a refresh token;
  `POST /api/Account/refresh-token {token, refreshToken}` returns a new pair.
- There is no admin endpoint for another user's preferences (theme); only the user's own session can
  read them (`GET /api/Users/get-preferences`).
- Auth keys: `POST /api/Account/create-auth-key {keyLength, name, expiresUtc}` (as the user).
  Kavita refuses (HTTP 400) for **Read Only** accounts. Keys are letters and digits.
- The admin API does not expose other users' keys.

## First run

- `GET /api/Admin/exists` → `true`/`false`.
- `POST /api/Account/register {username, password, email?}` creates the first admin only.
- `POST /api/Library/create` (UpdateLibraryDto) requires a valid `metadataProvider` for the library
  type even though the schema marks it optional; `GET /api/Library/metadata-providers?libraryType=<t>`
  lists the valid ones (Manga [3], Book [2,3], Comic/ComicVine [4,2]).
- Library types: 0 Manga, 1 Comic (flexible), 2 Book, 3 Image, 4 Light novel, 5 Comic (ComicVine).
  File groups: 1 archive, 2 EPUB, 3 PDF, 4 images.

## Libraries, series, parsing

- `GET /api/Library/libraries` → id, name, type, folders (`/data/...`).
- Series in a library: `POST /api/Series/v2?PageNumber=1&PageSize=N` with
  `{"statements":[{"comparison":0,"field":19,"value":"<libraryId>"}],"combination":1}`. Each series has
  `folderPath`.
- `GET /api/Series/volumes?seriesId=<id>` → volumes with chapters (`minNumber`; values ≤ -1000 mean "none").
- `GET /api/Plugin/parse?name=<filename>&libraryType=<type>` → `seriesName`, min/max volume and chapter
  numbers (Kavita's own file-name parser).
- **Embedded metadata wins:** ComicInfo.xml (comics) and the EPUB OPF (`calibre:series`) override
  folder and file names for series grouping. The portal therefore writes the approved series into the file.

## Scanning

- `POST /api/Library/scan-folder {apiKey, folderPath: "/data/<lib>/<Series>", abortOnNoSeriesMatch: false}`
  queues a scan; new series appeared about 60 s later.
- **Files at a library's root are ignored**; each series needs its own folder.
- `scan-folder` on a folder that no longer exists does nothing.
- A library scan aborts if a library's root folder is empty (Kavita assumes a disconnected drive), so
  the last series of a library can only be removed with `DELETE /api/Series/<id>`.
- Folder watching (library setting) also picks up new files.

## Users and admin actions

- `GET /api/Users` (admin) → id, username, roles, libraries (no keys).
- `POST /api/Account/update` (UpdateUserDto) changes roles/libraries; send all fields.
- `POST /api/Account/reset-password {userName, password}` with an admin key.

## Sidebar

- Sidebar "external source" entries render as `<host> + "login" + "?apiKey=" + <key>` and open in a new
  tab (`side-nav.component.html`).
- `GET /api/Stream/external-sources`, `POST /api/Stream/create-external-source {id:0,name,host,apiKey}`,
  `POST /api/Stream/update-external-source`, `POST /api/Stream/add-sidenav-stream-from-external-source?externalSourceId=<id>`,
  `GET /api/Stream/sidenav?visibleOnly=false` (stream type 6 = external source). All act on the signed-in user.
  Kavita does not validate the host.
- The entry's visible text **and** its hover tooltip are both the side-nav stream's `name`, which Kavita
  copies from the external source when the entry is created. `POST /api/Stream/update-sidenav-stream`
  changes **visibility only** (it ignores `name`), so to rename an entry: `DELETE /api/Stream/delete-external-source?externalSourceId=<id>`
  (200 with an empty body) and recreate the source with the new name, reusing the same auth key, then
  re-add the stream. The icon is Kavita's fixed `fa-server`; there is no icon field.
- `POST /api/Account/create-auth-key` key names must be unique per account (HTTP 400 otherwise).

## Themes

- `GET /api/Theme` → installed themes (`id`, `name`, `isDefault`, `provider` 1 system / 2 custom,
  `selector` e.g. `bg-dark`). A fresh install has only **Dark** (built in, no file:
  `GET /api/Theme/download-content?themeId=<dark>` returns 400 "Theme file missing or invalid").
- `GET /api/Theme/download-content?themeId=<id>` → the theme's CSS. Themes set Kavita's CSS variables in
  `:root .bg-<name> { … }`; variables not set fall back to Dark. Some catalogue entries are layout tweaks
  with no colour variables (e.g. Chapter-List-View); some start with `@import` (ElegantFin).
- Kavita applies a theme as a body class `bg-<name>`. For `bg-dark` and `bg-light` that class is also a
  Bootstrap utility with `!important`, so the page renders #212529 (Dark) and #f8f9fa (Light) regardless
  of the theme's `--bs-body-bg`.
- `GET /api/Theme/browse` → Kavita's official theme catalogue (16 themes); `POST /api/Theme/download-theme`
  (body: a catalogue entry) installs one; `DELETE /api/Theme?themeId=<id>` removes it (admin).
- A user's theme: `GET /api/Users/get-preferences` (as the user) → `theme`. Password login returns it in
  `preferences`; `POST /api/Plugin/authenticate` does not, but its token can call get-preferences.
  `POST /api/Users/update-preferences` needs the full preferences object.

## Files and links

- `GET /api/Series/volumes?seriesId=<id>` → each chapter's `files[].filePath` (Kavita's path, e.g.
  `/data/comics/Saga/Saga #001.cbz`); used to confirm an approved file is listed.
- Kavita's web UI route for a series: `/library/<libraryId>/series/<seriesId>` (verified by opening it).
- `POST /api/Library/scan?libraryId=<id>&force=false` queues a whole-library scan; needed after a folder is
  removed, because `scan-folder` ignores folders that no longer exist.
