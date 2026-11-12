export namespace TextStr {
    export const verifyAuthenticHeading = "Your Shell is authentic";
    export const verifyAuthenticPrompt = "Your Shell completed the verification correctly and is on our produced units list.";
    export const verifyNotRegisteredHeading = "Your Shell is not on our produced units list";
    export const verifyNotRegisteredPrompt = "The response was signed correctly, but no entry matches it. Contact us in Discord to go through the process together.";
    export const verifyErrorHeading = "Shell was not verified";
    export const verifyErrorPrompt = "Something went wrong. Go to Settings/Shell/Verify on your Shell and try again.";

    export const allowlistAbsent = "This site is serving no allowlist, so no Shell can be checked here.";
    export const allowlistRefused = "The allowlist this site serves does not verify against the key this page was built with, so nothing can be concluded from it.";

    export const producedUnitsListUpdated = (date: string) => `Produced units list last updated ${date}.`;

    export const scanning = "Scanning...";

    export const btnDone = "Done";
    export const btnTryAgain = "Try again";
    export const btnLearnMore = "Learn more";


    export const zoomPrompt = 'If you have issues scanning the QR, try to zoom in.';

    /* Update ERC20 Consts */

    export const shellConnectedPrompt = "Keycard Shell successfully connected";
    export const shellDisconnectPrompt = "You can disconnect Keycard Shell";

    export const progressDBPrompt = "Transferring database version ";
    export const progressFWPrompt = "Transferring firmware version ";

    export const dbTransferedText = "Database transferred";
    export const fwTransferedText = "Firmware transferred";

    export const startScreenHeadingDesktop = "Connect your Keycard Shell";
    export const startScreenHeadingMobile = "Connect via cable";

    export const startScreenPromptDesktop = "Unlock your Shell, then connect it with a USB-C cable.";
    export const startScreenPromptMobile = "Connect your Keycard Shell via USB-C cable";

    export const latest = "Up to date";
    export const variantSwitch = "Variant switch";
    export const updateAvailable = "New version";

    export const noUpdateNeeded = "The database and firmware are up to date";
    export const selectiveUpdate = "Update available — selective update supported";

    export const updateCanceled = "Update canceled by user";
    export const updateFailed = "Transfer failed";
    export const installationFailed = "Installation failed";

}