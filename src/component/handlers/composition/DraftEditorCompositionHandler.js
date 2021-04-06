/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @flow strict-local
 * @emails oncall+draft_js
 */

'use strict';

import type DraftEditor from 'DraftEditor.react';

const DOMObserver = require('DOMObserver');
const DraftModifier = require('DraftModifier');
const DraftOffsetKey = require('DraftOffsetKey');
const EditorState = require('EditorState');
const Keys = require('Keys');

const editOnSelect = require('editOnSelect');
const editOnInput = require('editOnInput');
const getContentEditableContainer = require('getContentEditableContainer');
const getEntityKeyForSelection = require('getEntityKeyForSelection');
const nullthrows = require('nullthrows');
const keyCommandInsertNewline = require('keyCommandInsertNewline');

/**
 * Millisecond delay to allow `compositionstart` to fire again upon
 * `compositionend`.
 *
 * This is used for Korean input to ensure that typing can continue without
 * the editor trying to render too quickly. More specifically, Safari 7.1+
 * triggers `compositionstart` a little slower than Chrome/FF, which
 * leads to composed characters being resolved and re-render occurring
 * sooner than we want.
 */
const RESOLVE_DELAY = 20;

/**
 * A handful of variables used to track the current composition and its
 * resolution status. These exist at the module level because it is not
 * possible to have compositions occurring in multiple editors simultaneously,
 * and it simplifies state management with respect to the DraftEditor component.
 */
let resolved = false;
let stillComposing = false;
let domObserver = null;

function startDOMObserver(editor: DraftEditor) {
  if (!domObserver) {
    domObserver = new DOMObserver(getContentEditableContainer(editor));
    domObserver.start();
  }
}

const DraftEditorCompositionHandler = {
  /**
   * A `compositionstart` event has fired while we're still in composition
   * mode. Continue the current composition session to prevent a re-render.
   */
  onCompositionStart: function(editor: DraftEditor): void {
    stillComposing = true;
    startDOMObserver(editor);
  },

  /**
   * Attempt to end the current composition session.
   *
   * Defer handling because browser will still insert the chars into active
   * element after `compositionend`. If a `compositionstart` event fires
   * before `resolveComposition` executes, our composition session will
   * continue.
   *
   * The `resolved` flag is useful because certain IME interfaces fire the
   * `compositionend` event multiple times, thus queueing up multiple attempts
   * at handling the composition. Since handling the same composition event
   * twice could break the DOM, we only use the first event. Example: Arabic
   * Google Input Tools on Windows 8.1 fires `compositionend` three times.
   */
  onCompositionEnd: function(editor: DraftEditor, e: SyntheticKeyboardEvent<>): void {
    resolved = false;
    stillComposing = false;

    if (e.data.endsWith('\n')) {
      // Gboard keyboard adds new line symbol to composition event
      // and don't send valid keyDown event when clicking enter
      // at the end of a word.
      DraftEditorCompositionHandler.resolveComposition(editor);
      const newState = keyCommandInsertNewline(editor._latestEditorState);
      editor.update(newState);
      editor.restoreEditorDOM({x: window.scrollX, y: window.scrollY});
      return;
    }

    setTimeout(() => {
      if (!resolved) {
        DraftEditorCompositionHandler.resolveComposition(editor);
      }
    }, RESOLVE_DELAY);
  },

  onSelect: editOnSelect,

  /**
   * Gboard keyboard don't send valid keyDown event
   * for backspace button only when merging blocks
   */
  onInput: function (editor: DraftEditor, e: SyntheticKeyboardEvent<>): void {
    if (e.nativeEvent.inputType === 'deleteContentBackward') {
      editOnInput(editor, e);
    }
  },

  /**
   * In Safari, keydown events may fire when committing compositions. If
   * the arrow keys are used to commit, prevent default so that the cursor
   * doesn't move, otherwise it will jump back noticeably on re-render.
   */
  onKeyDown: function(editor: DraftEditor, e: SyntheticKeyboardEvent<>): void {
    if (e.which === 229) {
      // 229 is a special value set for a keyCode relating to an event that has been processed by an IME
      // Gboard keyboard is sending it on every button press
      // https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event
      return;
    }

    if (!stillComposing) {
      // If a keydown event is received after compositionend but before the
      // 20ms timer expires (ex: type option-E then backspace, or type A then
      // backspace in 2-Set Korean), we should immediately resolve the
      // composition and reinterpret the key press in edit mode.
      DraftEditorCompositionHandler.resolveComposition(editor);
      editor._onKeyDown(e);
      setTimeout(() => editor.restoreEditorDOM({x: window.scrollX, y: window.scrollY}), 0);
      return;
    }
    if (e.which === Keys.RIGHT || e.which === Keys.LEFT) {
      e.preventDefault();
    }
  },

  /**
   * Keypress events may fire when committing compositions. In Firefox,
   * pressing RETURN commits the composition and inserts extra newline
   * characters that we do not want. `preventDefault` allows the composition
   * to be committed while preventing the extra characters.
   */
  onKeyPress: function(editor: DraftEditor, e: SyntheticKeyboardEvent<>): void {
    if (e.which === Keys.RETURN) {
      e.preventDefault();
    }
  },

  /**
   * Attempt to insert composed characters into the document.
   *
   * If we are still in a composition session, do nothing. Otherwise, insert
   * the characters into the document and terminate the composition session.
   *
   * If no characters were composed -- for instance, the user
   * deleted all composed characters and committed nothing new --
   * force a re-render. We also re-render when the composition occurs
   * at the beginning of a leaf, to ensure that if the browser has
   * created a new text node for the composition, we will discard it.
   *
   * Resetting innerHTML will move focus to the beginning of the editor,
   * so we update to force it back to the correct place.
   */
  resolveComposition: function(editor: DraftEditor): void {
    if (stillComposing) {
      return;
    }

    const mutations = nullthrows(domObserver).stopAndFlushMutations();
    domObserver = null;
    resolved = true;

    let editorState = EditorState.set(editor._latestEditorState, {
      inCompositionMode: false,
    });

    editor.exitCurrentMode();

    if (!mutations.size) {
      editor.update(editorState);
      return;
    }

    // TODO, check if Facebook still needs this flag or if it could be removed.
    // Since there can be multiple mutations providing a `composedChars` doesn't
    // apply well on this new model.
    // if (
    //   gkx('draft_handlebeforeinput_composed_text') &&
    //   editor.props.handleBeforeInput &&
    //   isEventHandled(
    //     editor.props.handleBeforeInput(
    //       composedChars,
    //       editorState,
    //       event.timeStamp,
    //     ),
    //   )
    // ) {
    //   return;
    // }

    let contentState = editorState.getCurrentContent();
    mutations.forEach((composedChars, offsetKey) => {
      const {blockKey, decoratorKey, leafKey} = DraftOffsetKey.decode(
        offsetKey,
      );

      const entityType = contentState.getBlockForKey(blockKey).getType();
      if (entityType === 'atomic') {
        return;
      }

      const {start, end} = editorState
        .getBlockTree(blockKey)
        .getIn([decoratorKey, 'leaves', leafKey]);

      const replacementRange = editorState.getSelection().merge({
        anchorKey: blockKey,
        focusKey: blockKey,
        anchorOffset: start,
        focusOffset: end,
        isBackward: false,
      });

      const entityKey = getEntityKeyForSelection(
        contentState,
        replacementRange,
      );
      const currentStyle = contentState
        .getBlockForKey(blockKey)
        .getInlineStyleAt(start);

      contentState = DraftModifier.replaceText(
        contentState,
        replacementRange,
        composedChars,
        currentStyle,
        entityKey,
      );

      editor.registerUnsyncedBlockKey(blockKey);

      // We need to update the editorState so the leaf node ranges are properly
      // updated and multiple mutations are correctly applied.
      editorState = EditorState.set(editorState, {
        currentContent: contentState,
      });
    });

    editor.restoreUnsyncedBlocksDOM();

    editor.update(
      EditorState.push(editorState, contentState, 'insert-characters'),
    );
  },
};

module.exports = DraftEditorCompositionHandler;
