# Keycard Shell Owner's Hub Website

Update and verify a Keycard Shell at [shell.keycard.tech](https://shell.keycard.tech).

## Update

Connect the Shell over USB and open [shell.keycard.tech/update/](https://shell.keycard.tech/update/) in a
browser that supports WebHID - Chrome, Edge or Opera. The page reports the versions the device is running and
lets you choose between the firmware and the token database. Firmware comes as a multicoin and a bitcoin-only
build.

The [air-gapped update](https://shell.keycard.tech/update/air-gapped) offers the same files with the
checksum of each, for updating in air-gapped mode. Earlier releases are listed under
[release notes](https://shell.keycard.tech/firmware/release-notes) and
[database version history](https://shell.keycard.tech/update/db-version-history).

## Verify

[Device verification](https://shell.keycard.tech/verify/) is the same process as before: the Shell scans a QR
on the screen, the page opens the camera and scans the QR the Shell answers with. The check itself has
changed. The page fetches the signed allowlist of every device that left the factory and authenticates it
against a pinned provisioning key, then looks up the signature your Shell made over a challenge generated
in that tab. Nothing is sent anywhere and nothing is stored; the answer is computed here, which is also why
the page no longer shows a QR of its own at the end for the Shell to scan.

The three answers are separate: the key is in the allowlist, the response is correctly signed but no row
matches it, and the response could not be checked at all. The third says nothing about the Shell, and the
second is not the same sentence as the first.
