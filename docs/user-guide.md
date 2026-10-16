# User guide

## Opening the upload portal

- From Kavita: click **Uploads** in the sidebar. It opens in a new tab, already signed in.
- Or go to the portal's address directly and sign in with your Kavita username and password.
  Doing this once adds **Uploads** to your Kavita sidebar.

Read Only Kavita accounts can sign in but can't upload.

The portal uses the same theme as your Kavita account (Settings → Theme in Kavita). If you change it,
the portal follows as soon as you switch back to its tab.

## Uploading

1. Choose the **library** (Manga, Comics or Books).
2. Drag files or whole folders onto the upload area, or use *browse files* / *browse folders*.
3. Press **Upload**.

Accepted: `.cbz .cbr .cb7 .zip .rar .7z` (comics/manga), `.epub` and `.pdf`; up to 8 GB per file,
3 at a time, and up to 50 GB waiting for review per person.

If your connection drops, the upload carries on by itself. If you close the page, add the same file
again and it continues where it stopped.

### Your uploads

| Status | Meaning |
|---|---|
| Uploading / Checking file… | Still arriving, or being checked |
| Waiting for review | Accepted; an admin will look at it. You can **Withdraw** it until then. |
| Being reviewed | An admin is approving it right now |
| In the library | Approved; it appears in Kavita within about a minute |
| Rejected | Not accepted by an admin; the reason is shown |
| Not accepted | The file isn't what its name says (e.g. a broken archive) and was discarded |
| Duplicate | The exact same file is already waiting or in the library; it was discarded |
| Cancelled / Expired / Withdrawn | Stopped by you, or abandoned for 24 hours |

## Notifications

Under **Your uploads** there is a **Notifications** panel. Choose where to be told when your uploads are
approved or rejected, when one of your files already in the library is corrected, when a file is
discarded because it isn't what its name says, or when a duplicate is found: a **Webhook** (JSON POST),
an **ntfy** topic URL, or a **Discord** webhook. Paste the address, tick the events you want and press
**Save**; **Send test** checks it works. Notifications are off until you set one up. On some servers,
addresses on the local network are refused (see [security.md](security.md)).

## Requests

**Requests** lets you ask for a series or issue you'd like in the library: type the title, optionally an
issue number, library and a note, and press **Ask for it**. Your asks appear under **My requests** with
their status. Kavita admins see everyone's open requests and can **Decline** one or **Mark fulfilled**;
approving a matching file fulfils the request automatically and — if you set notifications up — tells
you.

## Reviewing (Kavita admins)

Uploads waiting for review appear at the top of the portal, grouped: several issues of the same
series from the same person form one card.

**Shared fields** (top of the card): library, series, year, age rating, and under **More** credits,
publisher, genres, language. Leaving a field empty keeps whatever each file already says.

**Per file:** a cover (drawn like a Kavita tile, with the issue number badge), number, volume, title,
summary, and the file name. The file name follows the library's naming pattern as you edit the fields
(e.g. `Series v1 #007` for comics, `Series v01 c007` for manga); type over it to set your own.
*Will be saved as* shows exactly where the file will go.

**Warnings** to look at before approving:

- the metadata inside the file names a different series than the file name;
- the series name is close to an existing one (click *Use "…"?* to pick the existing one);
- that issue number is already in the series;
- no issue number (Kavita may treat it as a special);
- no metadata inside the file (it will be added from your values);
- the archive has no images or is unsafe (approval will fail; reject it).

**Approve** (or **Approve all** for a group) files it into the library in the background. Comic
archives are saved as CBZ with your values written into their ComicInfo.xml; EPUBs get their title,
authors and series updated; PDFs are renamed. Kavita shows it within about a minute. If something goes
wrong the file stays in the queue with the reason.

**Reject…** asks for a reason, which the uploader sees. Rejected files are kept for 7 days and can be
put back with **Restore to queue** under *Recent decisions*.

**Download** gets the original file if you want to check it first.

**Preview** pages through a comic's images in the portal (Previous / Next, or the arrow keys), so you
can check the content before approving without downloading it.

### After approving

Under **Recent decisions** each approved file shows *Checking that Kavita shows it…* and then
**In Kavita ✓ Open in Kavita** once Kavita lists it (usually within a minute). If Kavita hasn't listed it
after 15 minutes you'll see why, with **Check again**. Uploaders see the same link in *Your uploads*.

### Fixing an approved file

Click **Fix…** on an approved file (or find it with *Find an approved file to fix*). The same editor
opens, filled from the file as it is in the library now. Change the library, series, number, title,
metadata or file name and press **Save changes**. The file is rewritten in the background: comic
archives (including older .cbr files) become CBZ with your values in their ComicInfo.xml, the file moves
if the series or name changed, an emptied series folder is removed, and Kavita rescans. If anything goes
wrong the file in the library is left exactly as it was and the reason is shown. **Cancel** closes the
editor without changes.

## Activity (admins)

Below the review queue, **Activity** shows what has happened in the portal, newest first: sign-ins and
failed sign-ins, uploads, approvals, rejections, fixes, withdrawals and discarded files. Use the
**Action** and **User** filters to narrow it down and **Show older** to page back. The cards at the top
show what is waiting for review (and its total size), the last seven days of uploads/approvals/
rejections, and the most active uploader of the last month.
