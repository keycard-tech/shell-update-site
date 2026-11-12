import { marked } from "marked";
import { UIUtils } from "./ui_utils";

const mediaPrefix = document.getElementById('db_updater__media-prefix') as HTMLInputElement;

const releaseNotesContainer = document.getElementById("release-notes-container") as HTMLDialogElement;
const fwContainerClass = "keycard_shell__fw-release-notes";
const fwContainerId = "fw-rn-";

const fwVersionContainerClass = "keycard_shell__fw-version-container";
const fwVersionId = "fw-version-container-";

const fwChangelogContainerClass = "keycard_shell__fw-changelog-container";
const fwChangelogId = "fw-changelog-container-";

async function renderReleaseNotesUI(fw: any, fwId: number, changelog: string) : Promise<void> {
    const fwVersionContent = `<h2 class="keycard_shell__fw-version-content" id="v${fw["version"]}">${fw["version"]}</h2>`;
    const fwCreationDate = new Date(changelog.substring(0, changelog.indexOf('\n')).replace(/-/g, "/"));
    const containerId = fwContainerId + fw["version"];
    const versionContainerId = fwVersionId + fw["version"] as string;
    const changelogId = fwChangelogId + fw["version"] as string;
    
    const fwRNContainer = UIUtils.createElement("div", containerId, fwContainerClass, releaseNotesContainer);
    location.hash.substring(1) == containerId ? fwRNContainer.scrollIntoView() : null;

    UIUtils.createElement("div", versionContainerId, fwVersionContainerClass, fwRNContainer, fwVersionContent);

    const fwVersionChangelog = UIUtils.createElement("div", changelogId, fwChangelogContainerClass, fwRNContainer);

    if(!isNaN(fwCreationDate as any)) {
        let formattedDate = `${fwCreationDate.getDate()} ${fwCreationDate.toLocaleString('en-GB', { month: 'long' })} ${fwCreationDate.getFullYear()}`;
        changelog = changelog.substring(changelog.indexOf('\n'));
        fwVersionChangelog.innerHTML = `<span class="keycard_shell__fw-release-date">${formattedDate}</span>`
    }

    fwVersionChangelog.innerHTML = fwVersionChangelog.innerHTML + await marked(changelog);
}

async function handleReleaseNotes() : Promise<void> {
    const fwReleaseNotes = await fetch(mediaPrefix.value + "get-firmwares.json").then((r) => r.json());
    
    for (let i = 0; i < fwReleaseNotes.length; i++) {
        let changelogPath = fwReleaseNotes[i]["changelog"];
        const changelog = await fetch(mediaPrefix.value + changelogPath).then((r) => r.text());
        await renderReleaseNotesUI(fwReleaseNotes[i], i, changelog);
    }
}

handleReleaseNotes();