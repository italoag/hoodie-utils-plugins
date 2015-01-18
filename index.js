var _ = require('underscore');
var debug = require('debug');  
var moment = require('moment');

var utils = function (plugin) {

  var error = debug('plugin:' + plugin + ':error');
  var logc = debug('plugin:' + plugin + ':complete');
  var logs = debug('plugin:' + plugin + ':simple');
  var logsc = debug('plugin:' + plugin + ':success:complete');
  var logss = debug('plugin:' + plugin + ':success:simple');
  error.log = console.error.bind(console);
  return {
    debug: function () {
      return function (name, task) {
        var logText = 'ts: ' + moment().format() + ' m: ' + name;
        logs(logText);
        logc(logText, task); 
      }
    },

    handleTask: function (hoodie, methodname, db, task) {
      return function (err) {
        var logText = 'db: ' + db + ' ts: ' + moment().format() + ' m: ' + methodname;
        if (err) {
          error(logText + ' (error)', err);
          hoodie.task.error(db, task, err.error || { err: err });
        } else {
          logsc(logText + ' (sucess)', task);
          logss(logText + ' (sucess)');
          hoodie.task.success(db, task);
        }
      };
    },

    dbNametoHoodieId: function (dbName) {
      return dbName.replace(/^user\//, '');
    },

    /**
     * This code is part of hoodiehq/hoodie-plugins-api, patched to add `filters`
     * design capability
     *
     * see https://raw.githubusercontent.com/hoodiehq/hoodie-plugins-api/dd118e3b66dd520701f369f6410b1a05708db1a6/lib/database.js
     */
    /**
     * Extended DatabaseAPI
     */
    ExtendedDatabaseAPI: function ExtendedDatabaseAPI (hoodie, db) {

      var options = options || {};

      /**
       * CouchDB views created using `db.addIndex()` are all stored in the same
       * design document: `_design/views`.
       * See https://github.com/hoodiehq/hoodie.js/issues/70#issuecomment-20506841
       *
       * update:
       * @todo Open issue to add generic design documents API
       */

      function designDocAdd(ddoc_type, ddoc_name, ddoc_data, callback) {
        var ddoc_url = db._resolve('_design/' + ddoc_type), serialised;

        hoodie.request('GET', ddoc_url, {}, function (err, ddoc, res) {
          if (res.statusCode === 404) {
            // not found, so we use new object.
            ddoc = {
              language: 'javascript'
            };
            ddoc[ddoc_type] = {};
          } else if (err) {
            return callback(err);
          }

          // View functions need to be serialised/stringified.
          if (ddoc_type === 'views') {
            serialised = _.reduce(ddoc_data, function (memo, v, k) {
              memo[k] = _.isFunction(v) ? v.toString() : v;
              return memo;
            }, {});
          } else {
            serialised = ddoc_data.toString();
          }

          // If view code has not changed we don't need to do anything else.
          // NOTE: Not sure if this is the best way to deal with this. This
          // saves work and avoids unnecessarily overwriting the
          // `_design/views` document when no actual changes have been made to
          // the view code (map/reduce).
          if (_.isEqual(serialised, ddoc[ddoc_type][ddoc_name])) {
            return callback(null, {
              ok: true,
              id: ddoc._id,
              rev: ddoc._rev
            });
          }

          ddoc[ddoc_type][ddoc_name] = serialised;

          hoodie.request('PUT', ddoc_url, {data: ddoc}, callback);
        });
      }

      function designDocRemove(ddoc_type, ddoc_name, callback) {
        var ddoc_url = db._resolve('_design/' + ddoc_type);

        hoodie.request('GET', ddoc_url, {}, function (err, ddoc) {
          if (err) {
            return callback(err);
          }

          if (ddoc.views && ddoc[ddoc_type][ddoc_name]) {
            delete ddoc[ddoc_type][ddoc_name];
          }

          hoodie.request('PUT', ddoc_url, {data: ddoc}, callback);
        });
      }

      /**
       * Creates new design doc with CouchDB filter on db
       */

      db.addFilter = function (name, filterFunction, callback) {
        designDocAdd('filters', name, filterFunction, callback);
      };

      /**
       * Removes couchdb filter from db
       */

      db.removeFilter = function (name, callback) {
        designDocRemove('filters', name, callback);
      };

      /**
       * Add/remove indexes using generic methods

      /**
       * Creates new index design doc with CouchDB view on db
       */

      db.addIndex = function (name, mapReduce, callback) {
        designDocAdd('views', name, mapReduce, callback);
      };

      /**
       * Removes couchdb view from db
       */

      db.removeIndex = function (name, callback) {
        designDocRemove('views', name, callback);
      };


    /**
       * Query a couchdb view on db
       *
       * Arguments:
       *
       * * `index` is the name of the view we want to query.
       *
       * * `params` is an object with view query parameters to be passed on when
       * sending request to CouchDB. There is a special `params.parse` property
       * that is not passed to CouchDB but used to know whether we should parse
       * the values in the results as proper documents (translating couchdb's
       * `_id` to hoodie's `id` and so on). If your view's map function emits
       * whole documents as values you will probably want to use `params.parse` so
       * that you get a nice array of docs as you would with `db.findAll()`.
       */

      db.query = function (index, params, callback) {
        // `params` is optional, when only two args passed second is callback.
        if (arguments.length === 2) {
          callback = params;
          params = null;
        }

        var view_url = db._resolve('_design/views/_view/' + index);

        // If params have been passed we build the query string.
        if (params) {
          var qs = _.reduce(params, function (memo, v, k) {
            if (k === 'parse') { return memo; }
            if (memo) { memo += '&'; }
            return memo + k + '=' + encodeURIComponent(JSON.stringify(v));
          }, '');
          if (qs) {
            view_url += '?' + qs;
          }
        }

        hoodie.request('GET', view_url, function (err, data) {
          if (err) {
            return callback(err);
          }
          var results = data.rows;
          // If `params.parse` was set we need to parse the value in each row
          // as a proper document.
          if (params && params.parse) {
            results = data.rows.map(function (r) {
              return options.parse(r.value);
            });
          }
          callback(null, results, _.omit(data, [ 'rows' ]));
        });
      };

      return db;
    },

    ReplicatorAPI: function ReplicatorAPI (hoodie) {
      var Replicator = this;

      Replicator.find = function (type, id, callback) {
        var replicatorId = encodeURIComponent([type, id].join('/'));
        hoodie.request('GET', '/_replicator/' + replicatorId, {}, callback);
      };

      Replicator.add = function (type, id, data, callback) {
        Replicator.find(type, id, function (err, _doc, res) {
          if (res.statusCode === 404) {
            return hoodie.request('POST', '/_replicator', { data: data }, callback);
          } else if (err) {
            return callback(err);
          }
          return callback('Replicator already exists.', _doc);
        });
      };

      Replicator.remove = function (type, id, callback) {
        var replicatorId = encodeURIComponent([type, id].join('/'));
        Replicator.find(type, id, function (err, _doc, res) {
          if (res.statusCode === 404) {
            return callback('Replicator not found.');
          } else if (err) {
            return callback(err);
          }

          hoodie.request('DELETE', '/_replicator/' + replicatorId + '?rev=' + _doc._rev, {}, callback);
        });
      };

      return Replicator;
    }

  }
 
};
module.exports = exports = utils