// Operations like toHTML and toText use this function to
// establish a current computation if there isn't one.
// This ensures that Blaze.Vars are stopped (and in fact
// any Blaze.Var will complain if there isn't a current
// computation).
Blaze._inDummyComputation = function (f) {
  var ret;
  Blaze._wrapAutorun(Deps.autorun(function (c) {
    c.stop();
    ret = f();
  }));
  return ret;
};

////////////////////////////// Blaze.toText

Blaze.ToTextVisitor = HTML.ToTextVisitor.extend({
  visitObject: function (x) {
    if (x instanceof Blaze.RenderPoint)
      return x.toText(HTML.TEXTMODE.STRING);

    throw new Error("Unexpected object in htmljs in toText: " + x);
  },
  toHTML: function (node) {
    return Blaze.toHTML(node);
  }
});

var ToTextController = Blaze.ToTextController = function () {
  Blaze.Controller.call(this);
};
__extends(Blaze.ToTextController, Blaze.Controller);

Blaze.toText = function (content, textMode) {
  if (! Deps.active) {
    return Blaze._inDummyComputation(function () {
      return Blaze.toText(content, textMode);
    });
  }

  if (! textMode)
    throw new Error("textMode required for Blaze.toText");
  if (! (textMode === HTML.TEXTMODE.STRING ||
         textMode === HTML.TEXTMODE.RCDATA ||
         textMode === HTML.TEXTMODE.ATTRIBUTE))
    throw new Error("Unknown textMode: " + textMode);

  var visitor = new Blaze.ToTextVisitor;
  visitor.textMode = textMode;

  var controller = (Blaze.currentController || new ToTextController);
  return Blaze.withCurrentController(controller, function () {
    return visitor.visit(content);
  });
};

////////////////////////////// Blaze.toHTML

Blaze.ToHTMLVisitor = HTML.ToHTMLVisitor.extend({
  visitObject: function (x) {
    if (x instanceof Blaze.RenderPoint)
      return x.toHTML();

    throw new Error("Unexpected object in htmljs in toHTML: " + x);
  },
  toText: function (node, textMode) {
    return Blaze.toText(node, textMode);
  }
});

var ToHTMLController = Blaze.ToHTMLController = function () {
  Blaze.Controller.call(this);
};
__extends(Blaze.ToHTMLController, Blaze.Controller);

// This function is mainly for server-side rendering and is not in the normal
// code path for client-side rendering.
Blaze.toHTML = function (content) {
  if (! Deps.active) {
    return Blaze._inDummyComputation(function () {
      return Blaze.toHTML(content);
    });
  }
  var controller = (Blaze.currentController || new ToHTMLController);
  return Blaze.withCurrentController(controller, function () {
    return (new Blaze.ToHTMLVisitor).visit(content);
  });
};


////////////////////////////// Blaze.evaluate

Blaze.EvaluatingVisitor = HTML.TransformingVisitor.extend({
  visitObject: function (x) {
    if (x instanceof Blaze.RenderPoint)
      return x.evaluate();

    // this will throw an error; other objects are not allowed!
    return HTML.TransformingVisitor.prototype.visitObject.call(this, x);
  },
  visitAttributes: function (attrs) {
    if (attrs instanceof Blaze.Var)
      attrs = attrs.get();

    // call super (e.g. for case where `attrs` is an array)
    return HTML.TransformingVisitor.prototype.visitAttributes.call(this, attrs);
  }
});

// Expand all Vars and components, making the current computation depend on them.
Blaze.evaluate = function (content) {
  if (! (Blaze.currentController && Deps.active))
    throw new Error("Can only use Blaze.evaluate during rendering");

  return (new Blaze.EvaluatingVisitor).visit(content);
};

Blaze.evaluateAttributes = function (attrs) {
  if (! (Blaze.currentController && Deps.active))
    throw new Error("Can only use Blaze.evaluate during rendering");

  return (new Blaze.EvaluatingVisitor).visitAttributes(attrs);
};

////////////////////////////// Blaze.toDOM

Blaze.ToDOMVisitor = HTML.Visitor.extend({
  visitNull: function (x, intoArray) {
    return intoArray;
  },
  visitPrimitive: function (primitive, intoArray) {
    var string = String(primitive);
    intoArray.push(document.createTextNode(string));
    return intoArray;
  },
  visitArray: function (array, intoArray) {
    for (var i = 0; i < array.length; i++)
      this.visit(array[i], intoArray);
    return intoArray;
  },
  visitComment: function (comment, intoArray) {
    intoArray.push(document.createComment(comment.sanitizedValue));
    return intoArray;
  },
  visitRaw: function (raw, intoArray) {
    // Get an array of DOM nodes by using the browser's HTML parser
    // (like innerHTML).
    var nodes = Blaze.DOMBackend.parseHTML(raw.value);
    for (var i = 0; i < nodes.length; i++)
      intoArray.push(nodes[i]);

    return intoArray;
  },
  visitTag: function (tag, intoArray) {
    var tagName = tag.tagName;
    var elem;
    if (HTML.isKnownSVGElement(tagName) && document.createElementNS) {
      // inline SVG
      elem = document.createElementNS('http://www.w3.org/2000/svg', tagName);
    } else {
      // normal elements
      elem = document.createElement(tagName);
    }

    var rawAttrs = tag.attrs;
    var children = tag.children;
    if (tagName === 'textarea') {
      // turn TEXTAREA contents into a value attribute
      rawAttrs = (rawAttrs || {});
      rawAttrs.value = children;
      children = [];
    }

    if (rawAttrs) {
      var attrUpdater = new ElementAttributesUpdater(elem);
      var controller = Blaze.currentController;
      Blaze._wrapAutorun(Deps.autorun(function (c) {
        Blaze.withCurrentController(controller, function () {
          var evaledAttrs = Blaze.evaluateAttributes(rawAttrs);
          var flattenedAttrs = HTML.flattenAttributes(evaledAttrs);
          var stringAttrs = {};
          for (var attrName in flattenedAttrs) {
            stringAttrs[attrName] = Blaze.toText(flattenedAttrs[attrName],
                                                 HTML.TEXTMODE.STRING);
          }
          attrUpdater.update(stringAttrs);
        });
      }));
    }

    var childNodesAndRanges = this.visit(children, []);
    for (var i = 0; i < childNodesAndRanges.length; i++) {
      var x = childNodesAndRanges[i];
      if (x instanceof Blaze.DOMRange)
        x.attach(elem);
      else
        elem.appendChild(x);
    }

    intoArray.push(elem);

    return intoArray;
  },
  visitObject: function (x, intoArray) {
    if (x instanceof Blaze.RenderPoint) {
      intoArray.push(x.createDOMRange());
      return intoArray;
    }

    // throw the default error
    return HTML.Visitor.prototype.visitObject.call(this, x);
  }
});

Blaze.toDOM = function (content) {
  return (new Blaze.ToDOMVisitor).visit(content, []);
};
