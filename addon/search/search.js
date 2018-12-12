// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: https://codemirror.net/LICENSE

// Define search commands. Depends on dialog.js or another
// implementation of the openDialog method.

// Replace works a little oddly -- it will do the replace on the next
// Ctrl-G (or whatever is bound to findNext) press. You prevent a
// replace by making sure the match is no longer selected when hitting
// Ctrl-G.

// Was taken from CodeMirror/addon/search/search.js
// Forked from rev 7192a89300611014d56f37a348662812791d08e6

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    mod(require("../../lib/codemirror"), require("./searchcursor"), require("../dialog/dialog"));
  else if (typeof define == "function" && define.amd) // AMD
    define(["../../lib/codemirror", "./searchcursor", "../dialog/dialog"], mod);
  else // Plain browser env
    mod(CodeMirror);
})(function(CodeMirror) {
  "use strict";

  function displayNotFoundMsg(cm) {
    var helpMsg = cm.display.wrapper.querySelector(".CodeMirror-search-hint");
    if (helpMsg) {
      helpMsg.style.color = 'red';
      helpMsg.textContent = cm.phrase('No match found!');
    }
  }

  function restoreHintMsg(cm) {
    var helpMsg = cm.display.wrapper.querySelector(".CodeMirror-search-hint");
    if (helpMsg) {
      helpMsg.style.color = '#888';
      helpMsg.textContent = cm.phrase("(Use /re/ syntax for regexp search)");
    }
  }

  function searchOverlay(query, caseInsensitive) {
    if (typeof query == "string")
      query = new RegExp(query.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&"), caseInsensitive ? "gi" : "g");
    else if (!query.global)
      query = new RegExp(query.source, query.ignoreCase ? "gi" : "g");

    return {token: function(stream) {
      query.lastIndex = stream.pos;
      var match = query.exec(stream.string);
      if (match && match.index == stream.pos) {
        stream.pos += match[0].length || 1;
        return "searching";
      } else if (match) {
        stream.pos = match.index;
      } else {
        stream.skipToEnd();
      }
    }};
  }

  function SearchState() {
    this.posFrom = this.posTo = this.lastQuery = this.query = null;
    this.overlay = null;
  }

  function getSearchState(cm) {
    return cm.state.search || (cm.state.search = new SearchState());
  }

  function queryCaseInsensitive(query) {
    return typeof query == "string" && query == query.toLowerCase();
  }

  function getSearchCursor(cm, query, pos) {
    // Heuristic: if the query string is all lowercase, do a case insensitive search.
    return cm.getSearchCursor(query, pos, {caseFold: queryCaseInsensitive(query), multiline: true});
  }

  function persistentDialog(cm, text, deflt, onEnter, onKeyDown) {
    cm.openDialog(text, onEnter, {
      value: deflt,
      selectValueOnOpen: true,
      closeOnEnter: false,
      onClose: function() { clearSearch(cm); },
      onKeyDown: onKeyDown
    });
  }

  function persistentMultiInputDialog(cm, text, deflt, onEnter) {
    return cm.openDialog(text, onEnter, {
      value: deflt,
      selectValueOnOpen: true,
      closeOnEnter: false,
      onClose: function() { clearSearch(cm); },
      closeOnBlur: false,
      onKeyDown: function(event, value, closeFn) {
        var input = event.target;
        var searchInput = input.parentNode.querySelector('.search-term');
        var replaceInput = input.parentNode.querySelector('.replace-term');
        var opTypeField = input.parentNode.querySelector('.op-type');
        opTypeField.value = 'replace';
        var isSearchField = input.getAttribute('class').indexOf('search-term') > -1;
        var isReplaceField = input.getAttribute('class').indexOf('replace-term') > -1;
        var keyName = CodeMirror.keyName(event);
        var extra = cm.getOption('extraKeys'), cmd = (extra && extra[keyName]) || CodeMirror.keyMap[cm.getOption("keyMap")][keyName];
        if (isSearchField) {
          if (event.key === 'Tab') {
            input.parentNode.querySelector('.replace-term').focus();
            event.preventDefault();
          } else if (event.key === 'Enter' || cmd === "replace" || cmd === "findNext") {
            opTypeField.value = 'find';
            CodeMirror.e_stop(event);
          }
        } else if (isReplaceField && event.key === 'Tab') {
          input.parentNode.querySelector('.search-term').focus();
          event.preventDefault();
        } else if (event.key === 'Esc') {
          closeFn();
        }
      },
    });
  }

  function dialog(cm, text, shortText, deflt, f) {
    if (cm.openDialog) cm.openDialog(text, f, {value: deflt, selectValueOnOpen: true});
    else f(prompt(shortText, deflt));
  }

  function confirmDialog(cm, text, shortText, fs) {
    if (cm.openConfirm) cm.openConfirm(text, fs);
    else if (confirm(shortText)) fs[0]();
  }

  function parseString(string) {
    return string.replace(/\\(.)/g, function(_, ch) {
      if (ch == "n") return "\n"
      if (ch == "r") return "\r"
      return ch
    })
  }

  function parseQuery(query) {
    var isRE = query.match(/^\/(.*)\/([a-z]*)$/);
    if (isRE) {
      try { query = new RegExp(isRE[1], isRE[2].indexOf("i") == -1 ? "" : "i"); }
      catch(e) {} // Not a regular expression after all, do a string search
    } else {
      query = parseString(query)
    }
    if (typeof query == "string" ? query == "" : query.test(""))
      query = /x^/;
    return query;
  }

  function startSearch(cm, state, query) {
    state.queryText = query;
    state.query = parseQuery(query);
    cm.removeOverlay(state.overlay, queryCaseInsensitive(state.query));
    state.overlay = searchOverlay(state.query, queryCaseInsensitive(state.query));
    cm.addOverlay(state.overlay);
    if (cm.showMatchesOnScrollbar) {
      if (state.annotate) { state.annotate.clear(); state.annotate = null; }
      state.annotate = cm.showMatchesOnScrollbar(state.query, queryCaseInsensitive(state.query));
    }
  }

  function doSearch(cm, rev, persistent, immediate) {
    var state = getSearchState(cm);
    if (state.query) return findNext(cm, rev);
    var q = cm.getSelection() || state.lastQuery;
    if (q instanceof RegExp && q.source == "x^") q = null
    if (persistent && cm.openDialog) {
      var hiding = null
      var searchNext = function(query, event) {
        CodeMirror.e_stop(event);
        if (!query) return;
        if (query != state.queryText) {
          startSearch(cm, state, query);
          state.posFrom = state.posTo = cm.getCursor();
        }
        if (hiding) hiding.style.opacity = 1
        findNext(cm, event.shiftKey, function(_, to) {
          var dialog
          if (to.line < 3 && document.querySelector &&
              (dialog = cm.display.wrapper.querySelector(".CodeMirror-dialog")) &&
              dialog.getBoundingClientRect().bottom - 4 > cm.cursorCoords(to, "window").top)
            (hiding = dialog).style.opacity = .4
        })
      };
      persistentDialog(cm, getQueryDialog(cm), q, searchNext, function(event, query) {
        var keyName = CodeMirror.keyName(event)
        var extra = cm.getOption('extraKeys'), cmd = (extra && extra[keyName]) || CodeMirror.keyMap[cm.getOption("keyMap")][keyName]
        if (cmd == "findNext" || cmd == "findPrev" ||
          cmd == "findPersistentNext" || cmd == "findPersistentPrev") {
          CodeMirror.e_stop(event);
          startSearch(cm, getSearchState(cm), query);
          cm.execCommand(cmd);
        } else if (cmd == "find" || cmd == "findPersistent") {
          CodeMirror.e_stop(event);
          searchNext(query, event);
        }
      });
      if (immediate && q) {
        startSearch(cm, state, q);
        findNext(cm, rev);
      }
    } else {
      dialog(cm, getQueryDialog(cm), "Search for:", q, function(query) {
        if (query && !state.query) cm.operation(function() {
          startSearch(cm, state, query);
          state.posFrom = state.posTo = cm.getCursor();
          findNext(cm, rev);
        });
      });
    }
  }

  // Perform a search but from find/replace dialog
  function doPersistentSearch(cm, rev, query, immediate) {
    var state = getSearchState(cm);
    if (query !== state.query && state.query !== null) {
      startSearch(cm, state, query);
      state = getSearchState(cm);
    }
    if (state.query) {
      return findNext(cm, rev, function(_, to) {
        var dialog = cm.display.wrapper.querySelector(".CodeMirror-dialog");
        if (to.line >= 2 && dialog) {
          hiding = dialog;
          hiding.style.top = '';
          hiding.style.bottom = '';
        } else {
          hiding = dialog;
          hiding.style.bottom = 0;
          hiding.style.top = 'auto';
        }
      });
    }
    var q = cm.getSelection() || state.lastQuery;
    if (q instanceof RegExp && q.source == "x^") q = null
    if (cm.openDialog) {
      var hiding = null
      var searchNext = function(query, event) {
        CodeMirror.e_stop(event);
        if (!query) return;
        if (query != state.queryText) {
          startSearch(cm, state, query);
          state.posFrom = state.posTo = cm.getCursor();
        }
        if (hiding) {
          hiding.style.top = '';
          hiding.style.bottom = '';
        }
        findNext(cm, event.shiftKey, function(_, to) {
          var dialog
          if (to.line < 2 && document.querySelector &&
              (dialog = cm.display.wrapper.querySelector(".CodeMirror-dialog")) &&
              dialog.getBoundingClientRect().bottom - 4 > cm.cursorCoords(to, "window").top) {
                hiding = dialog;
                hiding.style.bottom = 0;
                hiding.style.top = 'auto';
          }
        })
      };

      var keyName = CodeMirror.keyName(event)
      var extra = cm.getOption('extraKeys'), cmd = (extra && extra[keyName]) || CodeMirror.keyMap[cm.getOption("keyMap")][keyName];
      if (cmd == "findNext" || cmd == "findPrev" ||
        cmd == "findPersistentNext" || cmd == "findPersistentPrev") {
        CodeMirror.e_stop(event);
        startSearch(cm, getSearchState(cm), query);
        cm.execCommand(cmd);
      } else if (cmd == "find" || cmd == "findPersistent" || cmd === undefined) {
        CodeMirror.e_stop(event);
        searchNext(query, event);
      }

      if (immediate && q) {
        startSearch(cm, state, q);
        findNext(cm, rev);
      }
    } else {
      dialog(cm, getQueryDialog(cm), "Search for:", q, function(query) {
        if (query && !state.query) cm.operation(function() {
          startSearch(cm, state, query);
          state.posFrom = state.posTo = cm.getCursor();
          findNext(cm, rev);
        });
      });
    }
  }

  function findNext(cm, rev, callback) {
    cm.operation(function() {
      var state = getSearchState(cm);
      var cursor = getSearchCursor(cm, state.query, rev ? state.posFrom : state.posTo);
      if (!cursor.find(rev)) {
        cursor = getSearchCursor(cm, state.query, rev ? CodeMirror.Pos(cm.lastLine()) : CodeMirror.Pos(cm.firstLine(), 0));
        if (!cursor.find(rev)) {
          displayNotFoundMsg(cm);
          return;
        }
      }
      restoreHintMsg(cm);
      cm.setSelection(cursor.from(), cursor.to());
      cm.scrollIntoView({from: cursor.from(), to: cursor.to()}, 20);
      state.posFrom = cursor.from(); state.posTo = cursor.to();
      if (callback) callback(cursor.from(), cursor.to())
    });
  }

  function clearSearch(cm) {cm.operation(function() {
    var state = getSearchState(cm);
    state.lastQuery = state.query;
    if (!state.query) return;
    state.query = state.queryText = null;
    cm.removeOverlay(state.overlay);
    if (state.annotate) { state.annotate.clear(); state.annotate = null; }
  });}


  function getQueryDialog(cm)  {
    return '<span class="CodeMirror-search-label">' + cm.phrase("Search:") + '</span> <input type="text" spellcheck="false" style="width: 10em" class="CodeMirror-search-field"/> <span style="color: #888" class="CodeMirror-search-hint">' + cm.phrase("(Use /re/ syntax for regexp search)") + '</span>';
  }
  function getReplaceQueryDialog(cm) {
    return ' <input type="text" spellcheck="false" style="width: 10em" class="CodeMirror-search-field search-term"/> <span style="color: #888; float: right" class="CodeMirror-search-hint">' + cm.phrase("(Use /re/ syntax for regexp search)") + '</span> <br/>' +
    '<span class="CodeMirror-search-label">' + cm.phrase("Replace with:") + '</span> <input type="text" spellcheck="false" style="width: 10em" class="CodeMirror-search-field replace-term"/> <input type="hidden" value="replace" class="op-type"/>';
  }
  function getReplacementQueryDialog(cm) {
    return '<span class="CodeMirror-search-label">' + cm.phrase("With:") + '</span> <input type="text" spellcheck="false" style="width: 10em" class="CodeMirror-search-field"/>';
  }
  function getDoReplaceConfirm(cm) {
    return '<span class="CodeMirror-search-label">' + cm.phrase("Replace?") + '</span> <button>' + cm.phrase("Yes") + '</button> <button>' + cm.phrase("No") + '</button> <button>' + cm.phrase("All") + '</button> <button>' + cm.phrase("Stop") + '</button> ';
  }

  function replaceAll(cm, query, text) {
    cm.operation(function() {
      for (var cursor = getSearchCursor(cm, query); cursor.findNext();) {
        if (typeof query != "string") {
          var match = cm.getRange(cursor.from(), cursor.to()).match(query);
          cursor.replace(text.replace(/\$(\d)/g, function(_, i) {return match[i];}));
        } else cursor.replace(text);
      }
    });
  }

  function replace(cm, all) {
    if (cm.getOption("readOnly")) return;
    var query = cm.getSelection() || getSearchState(cm).lastQuery;
    var dialogText = '<span class="CodeMirror-search-label">' + (all ? cm.phrase("Find all:") : cm.phrase("Find:")) + '</span>';
    if (cm.state.replaceDialog) {
      cm.state.replaceDialog();
    }
    var closeFn = persistentMultiInputDialog(cm, dialogText + getReplaceQueryDialog(cm), query, function(values) {
      var query = values[0],
          text = values[1],
          operationType = values[2];
      if (!query) return;
      query = parseQuery(query);
      text = parseString(text);

      if (operationType === 'replace') {
        if (all) {
          replaceAll(cm, query, text)
        } else {
          clearSearch(cm);
          var cursor = getSearchCursor(cm, query, cm.getCursor("from"));
          var advance = function() {
            var start = cursor.from(), match;
            if (!(match = cursor.findNext())) {
              cursor = getSearchCursor(cm, query);
              if (!(match = cursor.findNext()) ||
                  (start && cursor.from().line == start.line && cursor.from().ch == start.ch)) return;
            }
            cm.setSelection(cursor.from(), cursor.to());
            cm.scrollIntoView({from: cursor.from(), to: cursor.to()});
            closeFn();
            confirmDialog(cm, getDoReplaceConfirm(cm), cm.phrase("Replace?"),
                          [function() {doReplace(match);}, advance,
                           function() {replaceAll(cm, query, text)}]);
          };
          var doReplace = function(match) {
            cursor.replace(typeof query == "string" ? text :
                           text.replace(/\$(\d)/g, function(_, i) {return match[i];}));
            advance();
          };
          advance();
        }
      } else if (operationType === 'find') {
        doPersistentSearch(cm, false, query);
      } else {
        console.error('Unknow operation: ' + operationType);
      }
    });
    cm.state.replaceDialog = closeFn;
  }

  CodeMirror.commands.find = function(cm) {clearSearch(cm); doSearch(cm);};
  CodeMirror.commands.findPersistent = function(cm) {clearSearch(cm); doSearch(cm, false, true);};
  CodeMirror.commands.findPersistentNext = function(cm) {doSearch(cm, false, true, true);};
  CodeMirror.commands.findPersistentPrev = function(cm) {doSearch(cm, true, true, true);};
  CodeMirror.commands.findNext = doSearch;
  CodeMirror.commands.findPrev = function(cm) {doSearch(cm, true);};
  CodeMirror.commands.clearSearch = clearSearch;
  CodeMirror.commands.replace = function(cm) {clearSearch(cm); replace(cm)} ;
  CodeMirror.commands.replaceAll = function(cm) {replace(cm, true);};
});
