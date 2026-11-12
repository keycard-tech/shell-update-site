import { UIUtils } from "./ui_utils";

const mediaPrefix = document.getElementById('vh__media-prefix') as HTMLInputElement;

const versionHistoryContainer = document.getElementById("version-history-container") as HTMLDialogElement;
const dbContainerClass = "keycard_shell__db-version-history";
const dbContainerId = "db-v-";

const dbVersionContainerClass = "keycard_shell__db-version-container";
const dbVersionId = "db-version-container-";

const creationDateClass = "keycard_shell__creation-date";

const dbSourceContainerClass = "keycard_shell__db-source-container";
const sourceElementClass = "keycard_shell__db-source";
const sourceLinkClass = "keycard_shell__db-source-link";
const sourceLinkLabelClass = "keycard_shell__db-source-link-label";
const sourceLinkPath = "keycard_shell__db-source-link-path";
const dbDownloadBtnContainerClass = "keycard_shell__db-download-btn-container";
const dbDownloadBtnClass = "keycard_shell__db-download-btn";

const dateOptions = {year: "numeric", month: "long",day: "numeric", hour: "numeric", minute: "numeric"};

async function renderDBVersionHistoryUI(db: any, id: number, zipPath: string) : Promise<void> {
    const dbVersionContent = `<h2 class="keycard_shell__db-version-heading" id="v${db["version"]}">${db["version"]}</h2>`;
    const versionId = dbVersionId + db["version"] as string;
    const creationDateId = `release-date-${db["version"]}`;
    const dbVHContainer = UIUtils.createElement("div", dbContainerId + db["version"], dbContainerClass, versionHistoryContainer);
    const dbSourceContainerId = `source-container-${db["version"]}`;

    const dbCreationDate = new Date(db["creation_date"].replace(/-/g, "/"));
    const formattedDate = `${dbCreationDate.toLocaleString('en-GB', {weekday: "short"})}, ${dbCreationDate.toLocaleString('en-GB', dateOptions as any)}`;

    const tokenContent = `<a href="${db["token_link"]}" id="token-link-${db["version"]}" class="${sourceLinkClass}" target="_blank"><span class="${sourceLinkLabelClass}">Token list source</span><span class="${sourceLinkPath}">${UIUtils.shortLink(db["token_link"], 35)}</span></a>`;
    const chainContent = `<a href="${db["chain_link"]}" id="chain-link-${db["version"]}" class="${sourceLinkClass}" target="_blank"><span class="${sourceLinkLabelClass}">Chain list source</span><span class="${sourceLinkPath}">${UIUtils.shortLink(db["chain_link"], 35)}</span></a>`;
    const abiContent = `<a href="${db["abi_link"]}" id="abi-link-${db["version"]}" class="${sourceLinkClass}" target="_blank"><span class="${sourceLinkLabelClass}">ABI list source</span><span class="${sourceLinkPath}">${UIUtils.shortLink(db["abi_link"], 35)}</a>`;
    
    const downloadButton = `<a href="${zipPath}" id="btn-v${db["version"]}" class="${dbDownloadBtnClass} keycard_shell__btn">Download .zip</a>`;

    const versionContainer = UIUtils.createElement("div", versionId, dbVersionContainerClass, dbVHContainer, dbVersionContent);
    location.hash.substring(1) == versionId ? versionContainer.scrollIntoView({ behavior: "smooth"}) : null;

    UIUtils.createElement("span", creationDateId, creationDateClass, versionContainer, formattedDate);

    const dbSourceContainer = UIUtils.createElement("div", dbSourceContainerId, dbSourceContainerClass, dbVHContainer);

    UIUtils.createElement("span", `token-${db["version"]}`, sourceElementClass, dbSourceContainer, tokenContent);
    UIUtils.createElement("span", `chain-${db["version"]}`, sourceElementClass, dbSourceContainer, chainContent);
    UIUtils.createElement("span", `abi-${db["version"]}`, sourceElementClass, dbSourceContainer, abiContent);

    UIUtils.createElement("div", `download-${db["version"]}-btn-container`, dbDownloadBtnContainerClass, dbVHContainer, downloadButton);
}

async function handleDBVersionHistory() : Promise<void> {
    const dbVersionHistory = await fetch(mediaPrefix.value + "get-dbs.json").then((r) => r.json());

    for (let i = 0; i < dbVersionHistory.length; i++) {
        // zip_path is the release's own URL; a clicked download needs no same-origin copy.
        await renderDBVersionHistoryUI(dbVersionHistory[i], i, dbVersionHistory[i]["zip_path"]);
    }
}

handleDBVersionHistory();