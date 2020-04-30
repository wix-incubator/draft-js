'use strict';

import type {BlockNodeRecord} from 'BlockNodeRecord';
import type SelectionState from 'SelectionState';

const EditorState = require('EditorState');
const keyCommandPlainBackspace = require('keyCommandPlainBackspace');

//TODO: get list of triggers from activated plugins
const DECORATOR_CHARS = ['@', '#'];

function getTextDiff(textA: string, textB: string): string {
  return textA.split(textB).join('');
}

// This deletion is across multiple blocks and will result in the merging of two blocks.
function isBlockMerge(
  selection: SelectionState,
  lastUncollapsedSelection: ?SelectionState,
): boolean {
  const isMultiBlockSelection =
    lastUncollapsedSelection &&
    lastUncollapsedSelection.getAnchorKey() !==
      lastUncollapsedSelection.getFocusKey();
  return selection.getAnchorOffset() === 0 || isMultiBlockSelection;
}

// This text deleted contains a decorator.
function isDecoratorDeletion(
  block: BlockNodeRecord,
  domText: string,
  modelText: string,
): boolean {
  const eventTextDiff = getTextDiff(domText, modelText); // source of truth when deleting WITHOUT selection
  const stateTextDiff = getTextDiff(block.getText(), modelText); // source of truth when deleting WITH selection
  const hasEventTextDiff = DECORATOR_CHARS.some(
    trigger => eventTextDiff === trigger,
  );
  if (hasEventTextDiff) {
    return true;
  }

  const hasStateTextDiff = DECORATOR_CHARS.some(
    trigger => stateTextDiff.indexOf(trigger) > -1,
  );
  return hasStateTextDiff;
}

function deleteContentBackward(
  domText: string,
  modelText: string,
  block: BlockNodeRecord,
  editorState: EditorState,
  lastUncollapsedSelectionState: ?SelectionState,
): ?EditorState {
  if (
    domText === modelText || // No change -- the DOM is up to date. Nothing to do here.
    isBlockMerge(editorState.getSelection(), lastUncollapsedSelectionState) || //Backspace -- two blocks are merging.
    isDecoratorDeletion(block, domText, modelText) // Backspace -- removing decorator.
  ) {
    return keyCommandPlainBackspace(editorState, lastUncollapsedSelectionState);
  }
  return editorState;
}

module.exports = deleteContentBackward;
