import { makeWebRequest } from "../js/makeWebRequest.js";
import { isResponseUp } from "../js/isResponseUp.js";

// Add an event listener for the 'onInstalled' event, which means it will run when the extension when it will be first installed
browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    return initializeCreationOfBookmarkTree(details.reason);
  }

  return null;
});

// Add an event listener for the 'onStartup' event, which means it will run when Firefox starts up or when a new browser window is opened
browser.runtime.onStartup.addListener((details) => {
  // Here I couldn't find a way to check (if details.reason === "startup") so, this lines will be changed or not in release v1.6
  console.log(details);
  if (details.reason === "startup") {
    return initializeCreationOfBookmarkTree(details.reason);
  }

  return null;
});

// Listen for incoming messages from the extension's UI "Reload" button pressed
browser.runtime.onMessage.addListener((message) => {
  if (message.action === "reloadButton") {
    return initializeCreationOfBookmarkTree(message.action);
  }

  return null;
});


async function initializeCreationOfBookmarkTree(updateType) {
  const urlISDatabaseAPI = "https://api.github.com/repos/Illegal-Services/IS.Bookmarks/commits?path=IS.bookmarks.json&sha=extra&per_page=1";
  const urlRawISDatabase = "https://raw.githubusercontent.com/Illegal-Services/IS.Bookmarks/extra/IS.bookmarks.json";
  let response;

  response = await makeWebRequest(urlISDatabaseAPI);
  if (!await isResponseUp(response)) {
    return false;
  }

  const storageISDatabaseSHA = (await browser.storage.local.get("ISDatabaseSHA")).ISDatabaseSHA;
  const fetchedISDatabaseSHA = (await response.json()).sha;

  if (storageISDatabaseSHA === fetchedISDatabaseSHA) {
    if (updateType === "startup" || updateType === "scheduled") {
      return null;
    }
  }

  response = await makeWebRequest(urlRawISDatabase);
  if (!await isResponseUp(response)) {
    return false;
  }

  let responseText = (await response.text()).trim();

  let _bookmarkDb;
  try {
    _bookmarkDb = JSON.parse(responseText);
  } catch (error) {
    console.error(error);
  }
  let bookmarkDb = _bookmarkDb;

  if (
    (bookmarkDb === undefined)
    || (!Array.isArray(bookmarkDb))
    || (JSON.stringify(bookmarkDb[0]) !== '["FOLDER",0,"Bookmarks Toolbar"]') // Checks if the first array from the 'bookmarkDb' correctly matches the official IS bookmarks database
  ) {
    return false;
  }

  bookmarkDb = bookmarkDb.slice(1); // Slice the very first array which contains the "Bookmarks Toolbar" folder

  // Remove previous "Illegal Services" bookmark folder(s) from depth 0, before creating the new bookmark
  const filteredBookmarks = await searchBookmarksWithTypeAndDepth(null, null, "Illegal Services", "folder", 0);
  for (const object of filteredBookmarks) {
    await browser.bookmarks.removeTree(object.id);
  }

  await createBookmarkTree(bookmarkDb);
  await browser.storage.local.set({ "ISDatabaseSHA": fetchedISDatabaseSHA });
  return true;
}

async function searchBookmarksWithTypeAndDepth(query, url, title, type, depth) {
  // Search for bookmarks with the specified title
  const bookmarks = await browser.bookmarks.search({ query, url, title });

  // Function to calculate the depth of a bookmark using async recursion
  function calculateDepth(nodeId, currentDepth) {
    if (currentDepth > depth) {
      return -1; // Mark bookmarks beyond the specified depth
    }

    return browser.bookmarks.get(nodeId).then((node) => {
      if (!node.parentId) {
        return currentDepth; // We've reached the root node
      }
      return calculateDepth(node.parentId, currentDepth + 1);
    });
  }

  // Filter the bookmarks to include only those at the specified depth and match the target type
  const filteredBookmarks = await Promise.all(
    bookmarks.map(async (bookmark) => {
      const bookmarkDepth = await calculateDepth(bookmark.id, 0);
      if (bookmarkDepth === depth && bookmark.type === type) {
        return bookmark;
      }
      return null;
    })
  );

  // Remove null values (bookmarks that didn't match the criteria)
  const validBookmarks = filteredBookmarks.filter((bookmark) => bookmark !== null);

  return validBookmarks;
}

// Function to create a bookmark tree
async function createBookmarkTree(bookmarkDb) {
  const parentStack = ["toolbar_____"]; // Start with the Bookmarks Toolbar as the initial parent

  const total = bookmarkDb.length - 1; // Removes -1 because 'index' starts from 0
  const enumeratedDb = bookmarkDb.map((value, index) => [index, value]);
  for (const [index, entry] of enumeratedDb) {
    updateProgress(index * 100 / total);

    const type = entry[0];
    const depth = parseInt(entry[1]);

    const depthToRemove = (parentStack.length - depth);

    if (depthToRemove > 0) {
      parentStack.splice(-depthToRemove);
    }

    const parentId = parentStack[parentStack.length - 1];

    // DEBUG: console.log(parentStack, parentId, parentStack.length, depth, type, entry[2], entry[3]);

    if (type === "FOLDER") {
      const title = decodeHtmlEntityEncoding(entry[2]);
      const newFolder = await createBookmark(undefined, parentId, "folder", title, undefined);
      parentStack.push(newFolder.id); // Use the ID of the newly created folder
    } else if (type === "LINK") {
      const url = entry[2];
      const title = entry[3];
      await createBookmark(undefined, parentId, "bookmark", title, url);
    } else if (type === "HR") {
      await createBookmark(undefined, parentId, "separator", undefined, undefined);
    }
  }
}

// Function to create a bookmark
async function createBookmark(index, parentId, type, title, url) {
  return browser.bookmarks.create({ index, parentId, title, type, url });
}

// Function that sends a message to the popup script indicating that the background script is currently in the process of creating the bookmark
function updateProgress(progress) {
  browser.runtime.sendMessage({
    action: "updateProgress",
    progress
  })
  .catch((error) => {
    if (error.message !== "Could not establish connection. Receiving end does not exist.") {
      console.error(error);
    }
  });
}

// This function decodes HTML entities from a given string.
// This is required because when exporting bookmarks from Firefox, certain special characters (such as <, >, ", ' and &) in bookmark titles are encoded during the export process
function decodeHtmlEntityEncoding(string) {
  return string.replace(/&amp;|&quot;|&#39;|&lt;|&gt;/g, function (match) {
    switch (match) {
      case '&lt;': return '<';
      case '&gt;': return '>';
      case '&quot;': return '"';
      case '&#39;': return '\'';
      case '&amp;': return '&';
      default: return match;
    }
  });
}
