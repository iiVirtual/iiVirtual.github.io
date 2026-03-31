================================================================================
DEPLOY TO PORKBUN (fixes 403: zip alone is NOT a website)
================================================================================

1. On the SERVER (FileZilla remote): DELETE any old .zip and empty junk so the
   folder is clean or only has what you need.

2. Select EVERYTHING inside THIS folder EXCEPT this .txt file:
     index.html
     app.js
     styles.css
     manifest.json
     sw.js
     bundled_program.json
     icons  (whole folder)

3. DRAG those items into the FTP root (the folder FileZilla opens when you
   connect — same level where you had the zip).

4. After upload, the REMOTE side MUST show "index.html" in that folder.
   Open: https://YOURDOMAIN/ 

5. Do NOT rely on Porkbun "upload zip" unless you know it extracts into this
   same folder — a lone .zip causes 403.

Zip note: if you re-zip this folder for backup, on the server you still need
the EXTRACTED files — do not leave only a .zip on Porkbun.
================================================================================
