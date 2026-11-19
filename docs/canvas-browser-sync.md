# Canvas Browser Sync

Update your active BI Canvas courses and assignment deadlines from Chrome using desktop Study-OS on port 8765.

## Get started

1. Download the latest [Study-OS source ZIP](https://github.com/shadjosef/study-os/archive/refs/heads/main.zip), extract it, and launch desktop Study-OS. If you already use Study-OS, update your existing copy and restart it.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and choose the `canvas-sync-extension` folder in Study-OS. Pin **Study-OS Canvas Sync** from Chrome’s Extensions menu.
3. Open [Canvas Browser Sync](http://127.0.0.1:8765/canvas-connect.html) in desktop Study-OS and select **Get connection code**. Paste the code into the extension and select **Connect browser**. The Study-OS code expires in five minutes.

## Sync again

Open [BI Canvas](https://canvas.bi.no/) and sign in. Click the pinned **Study-OS Canvas Sync** extension. It starts syncing immediately. Select **View in Study-OS** to see upcoming deadlines or open the assignments by course. You can also find this page in **Schedule → Canvas deadlines**.

Leave desktop Study-OS running while syncing. If Canvas signs you out, sign back in and click the extension again. Repeated syncs replace the previous course and deadline list, including assignments that were removed or moved. Failed syncs preserve the last successful list.

## Access and data

The extension uses Chrome’s [active tab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) when you click its icon on BI Canvas. Canvas handles your browser sign-in. The extension passes course and assignment names, IDs and assigned due dates to desktop Study-OS. Study-OS builds the source links and saves the list under `data/state/canvas-browser.json`. If you keep Study-OS data in OneDrive, that file follows your OneDrive settings.

Select **Disconnect browser** in Study-OS to revoke the connection. The saved deadlines remain visible. One browser can be connected to each Study-OS data folder at a time.

This is a desktop pilot distributed as source. Use the existing [Canvas Archive workflow](../README.md#desktop-setup) for slides, PDFs, notebooks and Ed Discussion. For a shared sign-in integration, ask your institution about a scoped [Canvas OAuth developer key](https://developerdocs.instructure.com/services/canvas/oauth2/file.developer_keys).
