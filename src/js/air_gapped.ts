import { UIUtils } from "./ui_utils";

const mediaPrefix = document.getElementById('update__media-prefix') as HTMLInputElement;
const osSelector = document.getElementById('op-system-selector') as HTMLSelectElement;

const appDownloadBtn = document.getElementById("download-app-btn") as HTMLAnchorElement;
const appChangelogBtn = document.getElementById("app-changelog") as HTMLAnchorElement;
const appHash = document.getElementById("app-hash") as HTMLSpanElement;

const fwDownloadBtn = document.getElementById("download-fw") as HTMLAnchorElement;
const fwChangelogBtn = document.getElementById("fw-changelog") as HTMLAnchorElement;
const fwHash = document.getElementById("fw-hash") as HTMLSpanElement;
const fwBtnLabel = document.getElementById("download-fw-label") as HTMLSpanElement;

const dbDownloadBtn = document.getElementById("download-db") as HTMLAnchorElement;
const dbChangelogBtn = document.getElementById("db-changelog") as HTMLAnchorElement;
const dbHash = document.getElementById("db-hash") as HTMLSpanElement;
const dbBtnLabel = document.getElementById("download-db-label") as HTMLSpanElement;
const updaterDownloadPath = "https://github.com/keycard-tech/kshell-updater/releases/latest/download/";
const updaterName = "keycard-shell-updater-";

function generateDownloadLink(btn: HTMLAnchorElement, os: string) : void {
    if(os == "mac") {
        btn.href = updaterDownloadPath + updaterName + 'mac.zip';
    } else if(os == "windows") {
        btn.href = updaterDownloadPath + updaterName + 'win.exe';
    } else {
        btn.href = updaterDownloadPath + updaterName + 'lnx.AppImage';
    }
}

async function handleAirGappedUpdate() : Promise<void> {
    const fwContext = await fetch(mediaPrefix.value + "get-firmware.json").then((r) => r.json());
    const dbContext = await fetch(mediaPrefix.value + "get-db.json").then((r: any) => r.json());
    const fwFilePath = await fetch(mediaPrefix.value + fwContext["fw_path"]) as any;
    const dbFilePath = await fetch(mediaPrefix.value + dbContext["db_path"]) as any;
    
    osSelector.value = UIUtils.getOS();
    
    osSelector.addEventListener("change", () => generateDownloadLink(appDownloadBtn, osSelector.value));

    generateDownloadLink(appDownloadBtn, osSelector.value);

    fwBtnLabel.innerHTML = `Download Firmware ${fwContext["version"]}`;
    dbBtnLabel.innerHTML = `Download Database ${dbContext["version"]}`;

    fwHash.innerHTML = fwContext["hash"];
    dbHash.innerHTML = dbContext["hash"];

    fwDownloadBtn.href = fwFilePath.url;
    dbDownloadBtn.href = dbFilePath.url;

    fwChangelogBtn.href += `fw-rn-${fwContext["version"]}`;
    dbChangelogBtn.href += `db-version-container-${dbContext["version"]}`;
}

handleAirGappedUpdate();