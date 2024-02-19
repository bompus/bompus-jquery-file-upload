/*!
 * Bompus File Upload v1.0.7
 * https://github.com/bompus/bompus-jquery-file-upload
 *
 * Requires:
 * jquery 1.12+: <script src='https://cdn.jsdelivr.net/npm/jquery@1.12.4/dist/jquery.min.js'></script>
 * async 2.6.x: <script src='https://cdn.jsdelivr.net/npm/async@2.6.3/dist/async.min.js'></script>
 *
 * Copyright Aaron Queen
 */

// some tests on my 1 gigabit connection for a 96MB file
// 500KB, 5  parallel = 18 seconds
// 980KB, 1  parallel = ???
// 980KB, 3  parallel = 21 seconds
// 980KB, 5  parallel = 15 seconds ***** THE CHOSEN DEFAULT *****
// 980KB, 10 parallel = 17 seconds
// 2MB,   5  parallel = 14 seconds, random lag spikes, tests above 2MB also showed these random lag spikes

(function($) {
  function bompusFileUpload(options) {
    if (this instanceof bompusFileUpload === false) {
      return new bompusFileUpload(options);
    }

    var fieldName = options.fieldName !== undefined ? options.fieldName : "bompus-file-1";
    var hiddenInput = $('input[type=hidden][data-bfu-hidden="' + fieldName + '"]');
    var form = hiddenInput.closest("form");

    // deep extend
    this.o = $.extend(
      true,
      {
        // default options
        postUrl: "/path/to/upload.php",
        // the "name" of the hidden field on your form
        fieldName: fieldName,
        // 980KB chunks ( this leaves room for some overhead for other fields that are posted to remain under a 1MB POST )
        chunkSizeMB: 0.98,
        // number of chunks to send at a time
        parallelLimit: 5,
        // when falling back to full mode, do not allow a file over this size (in MB)
        maxFullSizeMB: 20,
        // we will attempt to retry a failed HTTP POST request this many times before giving up, set to 0 to disable retries
        maxRetries: 3,

        elements: {
          form: form,
          formSubmitBtn: form.find("[type=submit]"),
          infoText: $('div[data-bfu-text="' + fieldName + '"]'),
          fileInput: $('input[type=file][data-bfu-file="' + fieldName + '"]'),
          hiddenInput: hiddenInput
        },

        // any hooks that you provide in options will override the default example hooks
        hooks: {
          getFileDownloadUrl: function(uriEncodedFilename) {
            // you will almost always need to change this
            // special characters in filename have already been URI encoded
            return "/files/" + uriEncodedFilename;
          },
          getFileDownloadLinkClassName: function(uriEncodedFilename) {
            // special characters in filename have already been URI encoded
            var linkClass = "downloadLink";

            var re = /(?:\.([^.]+))?$/;
            var ext = re.exec(uriEncodedFilename)[1];
            if (ext === "jpg" || ext === "png" || ext === "gif") {
              linkClass = "imgLink";
            }

            return linkClass;
          },
          setText: function(fromInit, $dl, $remove) {
            // you can use this to override the logic below, which by default, sets the contents of div[data-bfu-text]

            var tmpElm = $("<div style='float:left;'></div>").addClass(
              this.readonly ? "bfu-dl-readonly" : "bfu-dl-editable"
            );
            tmpElm.append("<span class='bfu-dl-pre'></span>");

            // for existing files, provide a download link. for newly uploaded files, only display the filename without a link to download
            // tmpElm.append(fromInit ? $dl : this.currentFilename);

            // always append the link to download the existing/uploaded file
            tmpElm.append($dl);

            if (this.readonly === false) {
              tmpElm.append("<span class='bfu-dl-divider'>&nbsp;&nbsp;</span>", $remove);
            }

            this.setInfoText(tmpElm);
          },
          fileSelected: function(done) {
            // you can use this asynchronous hook to integrate with an image cropper, etc.
            // file blob can be accessed and modified at "this.file"
            // must call done(); when finished with file. if there is an error, call done("There was an error...")
            done();
          },
          beforeChunkSend: function(formData) {
            // you can use this hook to append custom fields, which you will almost always want
            formData.append("bfu_beforeChunkSend_hook", "abc123");
          },
          progressStart: function() {},
          progressEnd: function() {},
          uploadComplete: function() {}
        }
      },
      options
    );

    if (!window.FileReader || !window.Blob || !window.FormData) {
      // this should work in IE10+, so the browser is likely really old if we hit this error
      this.setInfoText(
        'Your browser appears to be outdated and does not support the upload mechanism being used. Please upgrade your browser to the latest version or use <a class="bluea" target="_blank" href="https://www.google.com/chrome/">Google Chrome</a> browser for the best experience.'
      );
      return;
    }

    // this must be a multiple of 1000 to keep things simple, so everything divides by 1000 evenly, no decimals, etc
    this.chunkSizeBytes = 1000 * 1000 * this.o.chunkSizeMB;

    this.currentFilename = $("<textarea />")
      .html(this.o.elements.hiddenInput.val())
      .text();

    this.readonly = this.o.elements.hiddenInput.prop("readonly") || this.o.elements.hiddenInput.prop("disabled");

    this.file = {};
    this.filename = "";
    this.filesize = -1;
    this.lastChunkNum = 1;
    this.method = "chunk"; // chunk or full
    this.chunkProgressPct = [];
    this.chunkProgressBytes = [];
    this.xhrs = [];
    this.uploadStarted = 0;
    this.uploadEnded = 0;
    this.uploadDuration = 0;
    this.bytesLeft = 0;
    this.secsLeft = 0;
    this.upSpeedKbps = 0;
    this.upSpeedMbps = 0;
    this.bfuBarFill = $("<div />");
    this.bfuBarText = $("<div />");

    if (this.currentFilename.length === 0) {
      this.reset();
    } else {
      this.setText(this.currentFilename, true);
    }

    var l = new limit();
    this.tickProgressDebounce = l.throttledUpdate(this.tickProgress, 500);

    this.o.elements.fileInput.on("change", this.onFileInputChange.bind(this));

    return this;
  }

  bompusFileUpload.prototype.disableFormSubmitEvent = function(e) {
    e.preventDefault();
    return false;
  };

  bompusFileUpload.prototype.resetProgress = function() {
    this.setInfoText(
      '<div class="bfu-bar"><div class="bfu-bar-fill"></div><div class="bfu-bar-text">0.0% | 0.00 Mbps | calculating remaining</div></div>'
    );
    this.bfuBarFill = this.o.elements.infoText.find(".bfu-bar-fill");
    this.bfuBarText = this.o.elements.infoText.find(".bfu-bar-text");
  };

  bompusFileUpload.prototype.onFileInputChange = function(e) {
    var self = this;

    e.preventDefault();

    this.file = this.o.elements.fileInput.get(0).files[0];
    this.method = "chunk";

    this.o.hooks.fileSelected.call(self, function(err) {
      if (err) {
        return self.setError(err);
      }

      self.filename = self.file ? self.file.name : "";
      self.filesize = self.file ? self.file.size : 0;

      var extension = self.filename.substr(self.filename.lastIndexOf(".") + 1, self.filename.length);

      if (!self.file) {
        return self.setError("File could not be loaded.");
      } else if (self.filename.length === 0) {
        return self.setError("File name could not be detected.");
      } else if (self.filesize <= 0) {
        return self.setError("File size could not be detected.");
      } else if (extension.length < 3 || extension.length > 4) {
        return self.setError("File must end with a type, such as .jpg or .jpeg");
      }

      self.o.elements.fileInput.prop("disabled", true).addClass("inProgress");
      self.resetProgress();
      self.toggleFormSubmit();
      self.upload_file();
    });

    return false;
  };

  bompusFileUpload.prototype.enableUpload = function() {
    this.o.elements.fileInput.removeClass("inProgress");
    this.toggleFormSubmit();

    if (this.readonly === true) {
      this.setInfoText("No File Uploaded");
      this.o.elements.fileInput.hide();
      return;
    }

    this.setInfoText("");
    this.o.elements.fileInput.prop("disabled", false).show();
    this.o.elements.fileInput.get(0).value = null;
    this.method = "chunk";
  };

  bompusFileUpload.prototype.reset = function() {
    this.enableUpload();
    this.o.elements.hiddenInput.val("");
  };

  bompusFileUpload.prototype.setError = function(message) {
    this.reset();
    this.setInfoText("<span class='bfu-error'>Error: " + message + "</span>");
  };

  bompusFileUpload.prototype.setInfoText = function(htmlOrElm) {
    if (htmlOrElm === "") {
      this.o.elements.infoText.empty().hide();
      return;
    }

    this.o.elements.infoText
      .empty()
      .append(htmlOrElm)
      .show();
  };

  bompusFileUpload.prototype.setText = function(filename, fromInit) {
    var self = this;

    this.currentFilename = filename;
    this.encodedFilename = encodeURIComponent(this.currentFilename);
    this.currentUrl = this.o.hooks.getFileDownloadUrl.call(this, this.encodedFilename);
    this.linkClass = this.o.hooks.getFileDownloadLinkClassName.call(this, this.encodedFilename);
    this.o.elements.hiddenInput.val(this.currentFilename);

    var $dl = $("<a />")
      .attr({
        target: "_blank",
        class: "bfu-dl " + this.linkClass,
        href: this.currentUrl
      })
      .html(this.currentFilename);

    var $remove = $("<a />")
      .attr({
        target: "_blank",
        class: "bfu-remove",
        href: "#"
      })
      .html("Remove")
      .on("click", function(e) {
        e.preventDefault();
        self.reset();
      });

    this.enableUpload();
    this.o.elements.fileInput.hide();

    this.o.hooks.setText.call(this, fromInit, $dl, $remove);
  };

  bompusFileUpload.prototype.tickProgress = function(isComplete) {
    var percent_done = 0;

    if (isComplete === true) {
      percent_done = "100";
      this.tickProgressDebounce.cancel();
      this.uploadEnded = Date.now();
      this.uploadDuration = (this.uploadEnded - this.uploadStarted) / 1000;
      this.uploadDuration = Number(this.uploadDuration.toFixed(2));

      // if we do not null the fileInput value, the browser auto triggers on("change") and will re-upload when navigating forward/back in the browser
      this.o.elements.fileInput.get(0).value = null;
    } else {
      var pctSum = this.chunkProgressPct.reduce(function(a, b) {
        return a + b;
      }, 0);
      percent_done = pctSum / this.chunkProgressPct.length;
      percent_done = Math.min(percent_done, 99.9);
      percent_done = percent_done.toFixed(1);

      var bytesSum = this.chunkProgressBytes.reduce(function(a, b) {
        return a + b;
      }, 0);

      var elapsed = (Date.now() - this.uploadStarted) / 1000;
      var bps = elapsed ? bytesSum / elapsed : 0;

      this.bytesLeft = Math.max(0, this.filesize - bytesSum);
      this.upSpeedKBps = Math.ceil(bps / 1024);
      this.upSpeedMbps = (this.upSpeedKBps / 125).toFixed(2);
      this.secsLeft = elapsed ? Math.max(1, Math.ceil(this.bytesLeft / bps)) : "calculating";
    }

    this.bfuBarFill.css("width", percent_done + "%");
    var tmpText = [percent_done + "%", this.upSpeedMbps + " Mbps", this.secsLeft + " seconds remaining"].join(" | ");
    this.bfuBarText.html(tmpText);
  };

  bompusFileUpload.prototype.toggleFormSubmit = function() {
    var thisInProgress = this.o.elements.fileInput.hasClass("inProgress");
    var anyInProgress = this.o.elements.form.find("input[type=file].inProgress").length > 0;

    if (this.o.elements.formSubmitBtn.length === 0) {
      this.o.elements.formSubmitBtn = this.o.elements.form.find("[type=submit]");
    }

    if (anyInProgress) {
      this.o.elements.form.off("submit.bfu").on("submit.bfu", this.disableFormSubmitEvent);
      this.o.elements.formSubmitBtn.prop("disabled", true);
    } else {
      this.o.elements.form.off("submit.bfu");
      this.o.elements.formSubmitBtn.prop("disabled", false);
    }

    if (thisInProgress) {
      this.o.hooks.progressStart.call(this);
    } else {
      this.o.hooks.progressEnd.call(this);
    }
  };

  bompusFileUpload.prototype.upload_chunk = function(myChunkNum, myAction, retryNum, cb) {
    var self = this;

    var progressIdx = myChunkNum - 1;
    var lengthComputable = false;
    var formData = new FormData();
    var start = (myChunkNum - 1) * this.chunkSizeBytes;
    var end = Math.min(start + this.chunkSizeBytes, this.filesize);
    var myChunkByteLen = end - start;

    formData.append("file_name", this.filename);
    formData.append("file_size", this.filesize);
    formData.append("file_chunk", myChunkNum);
    formData.append("file_chunk_max", this.lastChunkNum);
    formData.append("chunk_action", myAction);
    formData.append("chunk_method", this.method);
    formData.append("retry_num", retryNum);

    this.o.hooks.beforeChunkSend.call(this, formData);

    if (myAction === "sendChunk") {
      if (this.method === "chunk") {
        formData.append("file", this.file.slice(start, end));
      } else if (this.method === "full") {
        if (this.file.size > this.o.maxFullSizeMB * 1024 * 1024) {
          return cb("File is too large. Please try again with a file smaller than " + this.o.maxFullSizeMB + "MB.");
        }

        formData.append("file", this.file);
      }
    }

    var xhr = $.ajax({
      url: this.o.postUrl,
      type: "POST",
      dataType: "json",
      cache: false,
      data: formData,
      processData: false,
      contentType: false,
      xhr: function() {
        var xhr = new window.XMLHttpRequest();

        xhr.upload.addEventListener(
          "progress",
          function(e) {
            lengthComputable = e.lengthComputable;
            if (lengthComputable && myAction === "sendChunk") {
              // progress event is more accurate, but we fallback if for some reason lengthComputable is not truthy (1/2)
              self.chunkProgressBytes[progressIdx] = e.loaded;
              self.chunkProgressPct[progressIdx] = (e.loaded / e.total) * 100;
              self.tickProgressDebounce(false);
            }
          },
          false
        );

        return xhr;
      },
      error: function(jqXHR, textStatus, errorThrown) {
        if (this.method === "chunk" && myAction === "sendChunk" && retryNum < self.o.maxRetries) {
          // if chunking, and any sendChunk request "fails" ( timeout, server error, non-200 status code ), we retry it after a delay of (retryNum * 1000ms)
          retryNum++;

          setTimeout(function() {
            self.upload_chunk(myChunkNum, myAction, retryNum, cb);
          }, retryNum * 1000);

          return;
        }

        return cb(textStatus);
      },
      success: function(data) {
        if (!data) {
          data = {};
        }

        if (data.success !== true) {
          data = data.data ? data.data : data;
          var errMessage = data.message ? data.message : "Unknown Error E340.";
          return cb(errMessage);
        }

        if (!lengthComputable && myAction === "sendChunk") {
          // progress event is more accurate, but we fallback if for some reason lengthComputable is not truthy (2/2)
          self.chunkProgressBytes[progressIdx] = myChunkByteLen;
          self.chunkProgressPct[progressIdx] = 100;
          self.tickProgressDebounce(false);
        }

        if (myAction === "combineChunks") {
          self.tickProgress(true);
        }

        data = data.data ? data.data : data;
        if (!data.file_name) {
          return cb("Unknown Error E356.");
        }

        return cb(null, data);
      }
    });

    this.xhrs.push(xhr);
  };

  bompusFileUpload.prototype.upload_file = function() {
    var self = this;

    this.chunkProgressPct = [];
    this.chunkProgressBytes = [];
    this.xhrs = [];

    if (this.method === "chunk") {
      this.lastChunkNum = Math.ceil(this.filesize / this.chunkSizeBytes);
    } else if (this.method === "full") {
      this.lastChunkNum = 1;
    }

    for (var i = 0; i < this.lastChunkNum; i++) {
      this.chunkProgressPct[i] = 0;
      this.chunkProgressBytes[i] = 0;
    }

    async.series(
      {
        initUpload: function(cb) {
          self.upload_chunk(0, "initFile", 0, cb);
        },
        sendChunks: function(cb) {
          self.uploadStarted = Date.now();

          return async.timesLimit(
            self.lastChunkNum,
            self.o.parallelLimit,
            function(n, cb) {
              self.upload_chunk(n + 1, "sendChunk", 0, cb);
            },
            cb
          );
        },
        combineChunks: function(cb) {
          self.upload_chunk(self.lastChunkNum, "combineChunks", 0, cb);
        }
      },
      function(err, res) {
        if (err) {
          async.whilst(
            function() {
              // we have to wait for pending requests to finish, or else we race when starting a full upload retry

              var isPending = 0;
              self.xhrs.forEach(function(xhr) {
                if (xhr.readyState !== 4) {
                  isPending++;
                }
              });

              return isPending > 0;
            },
            function(cb) {
              setTimeout(cb, 100);
            },
            function() {
              if (err.indexOf("Unknown Error") === -1) {
                if (self.method === "chunk") {
                  // if we error and have exceeded maxRetries, try a full upload instead of chunk
                  self.method = "full";
                  self.resetProgress();
                  return self.upload_file();
                }
              }

              return self.setError(err);
            }
          );

          return;
        }

        self.setText(res.combineChunks.file_name, false);
        self.o.hooks.uploadComplete.call(self);
      }
    );
  };

  // this makes it available at jQuery.bompusFileUpload({});
  $.extend({ bompusFileUpload: bompusFileUpload });

  // BEGIN: limit object inspired by https://github.com/Almenon/throttle, compiled from TS into ES5-compatible JS, removed exports
  function __spreadArrays() {
    for (var b = 0, d = 0, e = arguments.length; d < e; d++) b += arguments[d].length;
    b = Array(b);
    var c = 0;
    for (d = 0; d < e; d++) for (var a = arguments[d], f = 0, g = a.length; f < g; f++, c++) b[c] = a[f];
    return b;
  }

  var limit = (function() {
    function limit() {
      this.interval = null;
      this.lastCall = null;
    }

    limit.prototype.cancel = function() {
      clearInterval(this.interval);
      this.interval = null;
      this.lastCall = null;
    };

    limit.prototype.throttledUpdate = function(fn, wait) {
      var self = this;

      function caller() {
        if (!self.interval) {
          self.lastCall.call();
          self.lastCall = null;
          self.interval = setInterval(function() {
            if (self.lastCall) {
              self.lastCall.call();
              self.lastCall = null;
            } else {
              clearInterval(self.interval);
              self.interval = null;
            }
          }, wait);
        }
      }

      var rtn = function() {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
          args[_i] = arguments[_i];
        }
        self.lastCall = fn.bind.apply(fn, __spreadArrays([this], args));
        caller();
      };
      rtn.cancel = self.cancel;
      return rtn;
    };

    limit.prototype.throttle = function throttle(fn, wait) {
      var isCalled = false;
      return function() {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
          args[_i] = arguments[_i];
        }
        if (!isCalled) {
          fn.apply(void 0, args);
          isCalled = true;
          setTimeout(function() {
            isCalled = false;
          }, wait);
        }
      };
    };

    return limit;
  })();
  // END: limit object inspired by https://github.com/Almenon/throttle, compiled from TS into ES5-compatible JS, removed exports
})(jQuery);
