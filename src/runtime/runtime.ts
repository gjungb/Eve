//---------------------------------------------------------------------
// Runtime
//---------------------------------------------------------------------

import {PerformanceTracker, NoopPerformanceTracker} from "./performance";

const TRACK_PERFORMANCE = true;
const MAX_ROUNDS = 300;

//---------------------------------------------------------------------
// Setups
//---------------------------------------------------------------------

import {} from "./join"
import {MultiIndex, TripleIndex} from "./indexes"
import {Block, RemoteBlock} from "./block"
import {Changes} from "./changes"
import {Action} from "./actions"
import {ids} from "./id";

//---------------------------------------------------------------------
// Database
//---------------------------------------------------------------------

export class Database {
  static id = 1;

  id: string;
  blocks: Block[];
  index: TripleIndex;
  evaluations: Evaluation[];
  nonExecuting: boolean;

  constructor() {
    this.id = `db|${Database.id}`;
    Database.id++;
    this.evaluations = [];
    this.blocks = [];
    this.index = new TripleIndex(0);
  }

  register(evaluation: Evaluation) {
    if(this.evaluations.indexOf(evaluation) === -1) {
      this.evaluations.push(evaluation);
    }
  }

  unregister(evaluation: Evaluation) {
    let evals = this.evaluations;
    let index = evals.indexOf(evaluation);
    if(index > -1) {
      evals.splice(index, 1);
    } else {
      throw new Error("Trying to unregister an evaluation that isn't registered with this database");
    }
  }

  onFixpoint(currentEvaluation: Evaluation, changes: Changes) {
    let name = currentEvaluation.databaseToName(this);
    let commit = changes.toCommitted({[name]: true});
    if(commit.length === 0) return;
    for(let evaluation of this.evaluations) {
      if(evaluation !== currentEvaluation) {
        evaluation.queue({type: QueuedType.commit, commit});
      }
    }
  }

  toTriples() {
    return this.index.toTriples(true);
  }

  analyze(e: Evaluation, d: Database) {}
}

//---------------------------------------------------------------------
// Evaluation
//---------------------------------------------------------------------

type EvaluationCallback = (changes: Changes) => void;

enum QueuedType {
  commit,
  actions,
  changes,
}

interface QueuedEvaluation {
  type: QueuedType,
  commit?: any[],
  actions?: Action[],
  changes?: Changes,
  callback?: EvaluationCallback,
  waitingFor?: {[key: string]: boolean},
  waitingCount?: number,
  start?: number,
}

export class Evaluation {
  queued: boolean;
  currentEvaluation: QueuedEvaluation;
  evaluationQueue: QueuedEvaluation[];
  multiIndex: MultiIndex;
  databases: Database[];
  errorReporter: any;
  databaseNames: {[dbId: string]: string};
  nameToDatabase: {[name: string]: Database};
  perf: PerformanceTracker;
  nextTick: (func) => void;

  constructor(index?) {
    this.queued = false;
    this.evaluationQueue = [];
    this.databases = [];
    this.databaseNames = {};
    this.nameToDatabase = {};
    this.multiIndex = index || new MultiIndex();
    if(TRACK_PERFORMANCE) {
      this.perf = new PerformanceTracker();
    } else {
      this.perf = new NoopPerformanceTracker();
    }
    if(typeof process !== "undefined") {
      this.nextTick = process.nextTick;
    } else {
      this.nextTick = (func) => {
        setTimeout(func, 0);
      }
    }
  }

  error(kind: string, error: string) {
    if(this.errorReporter) {
      this.errorReporter(kind, error);
    } else {
      console.error(kind + ":", error);
    }
  }

  unregisterDatabase(name) {
    let db = this.nameToDatabase[name];
    delete this.nameToDatabase[name];
    if(!db) return;

    this.databases.splice(this.databases.indexOf(db), 1);
    delete this.databaseNames[db.id];
    this.multiIndex.unregister(name);
    db.unregister(this);
  }

  registerDatabase(name: string, db: Database) {
    if(this.nameToDatabase[name]) {
      throw new Error("Trying to register a database name that is already registered: " + name);
    }
    for(let database of this.databases) {
      db.analyze(this, database);
      database.analyze(this, db);
    }
    this.databases.push(db);
    this.databaseNames[db.id] = name;
    this.nameToDatabase[name] = db;
    this.multiIndex.register(name, db.index);
    db.register(this);
  }

  databaseToName(db: Database) {
    return this.databaseNames[db.id];
  }

  getDatabase(name: string) {
    return this.nameToDatabase[name];
  }

  blocksFromCommit(commit) {
    let perf = this.perf;
    let start = perf.time();
    let blocks = [];
    let index = this.multiIndex;
    let tagsCache = {};
    for(let database of this.databases) {
      if(database.nonExecuting) continue;
      for(let block of database.blocks) {
        if(block.dormant) continue;
        let checker = block.checker;
        for(let ix = 0, len = commit.length; ix < len; ix += 6) {
          let change = commit[ix];
          let e = commit[ix + 1];
          let a = commit[ix + 2];
          let v = commit[ix + 3];

          let tags = tagsCache[e];
          if(tags === undefined) {
            tags = tagsCache[e] = index.dangerousMergeLookup(e,"tag",undefined);
          }

          if(checker.check(index, change, tags, e, a, v)) {
            blocks.push(block);
            break;
          }
        }
      }
    }
    perf.blockCheck(start);
    // console.log("executing blocks", blocks.map((x) => x));
    return blocks;
  }

  getAllBlocks() {
    let blocks = [];
    for(let database of this.databases) {
      if(database.nonExecuting) continue;
      for(let block of database.blocks) {
        if(block.dormant) continue;
        blocks.push(block);
      }
    }
    return blocks;
  }

  processQueue() {
    this.nextTick(() => {
      if(this.evaluationQueue.length) {
        let commits = [];
        let queued = this.evaluationQueue.shift();
        let finished = (changes) => {
          if(this.evaluationQueue.length) {
            this.processQueue();
          } else {
            this.queued = false;
          }
          if(queued.callback) queued.callback(changes);
        }
        if(queued.type === QueuedType.commit) {
          for(let field of queued.commit) {
            commits.push(field);
          }
          this.fixpoint(new Changes(this.multiIndex), this.blocksFromCommit(commits), finished);
        } else if(queued.type === QueuedType.actions) {
          let {actions, changes, callback} = queued;
          for(let action of actions) {
            action.execute(this.multiIndex, [], changes);
          }
          let committed = changes.commit();
          this.fixpoint(changes, this.blocksFromCommit(committed), finished);
        }
      }
    });
  }

  queue(evaluation: QueuedEvaluation) {
    if(!this.queued && !this.currentEvaluation) {
      this.processQueue();
    }
    evaluation.waitingFor = {};
    evaluation.waitingCount = 0;
    this.evaluationQueue.push(evaluation);
  }

  createChanges() {
    return new Changes(this.multiIndex);
  }

  executeActions(actions: Action[], changes = this.createChanges(), callback?: EvaluationCallback) {
    this.queue({type: QueuedType.actions, actions, changes, callback});
  }

  _fixpointRound(evaluation: QueuedEvaluation, blocks) {
    let perf = this.perf;
    let {changes} = evaluation;
    evaluation.waitingCount = 0;
    if(changes.changed && changes.round < MAX_ROUNDS) {
      changes.nextRound();
      // console.groupCollapsed("Round" + changes.round);
      for(let block of blocks) {
        if(block instanceof RemoteBlock) {
          evaluation.waitingFor[block.id] = true;
          evaluation.waitingCount++;
        }
        let start = perf.time();
        block.execute(this.multiIndex, changes);
        perf.block(block.id, start);
      }
      // console.log(changes);
      if(evaluation.waitingCount === 0) {
        let commit = changes.commit();
        blocks = this.blocksFromCommit(commit);
        this._fixpointRound(evaluation, blocks);
      }
    } else {
      if(changes.round >= MAX_ROUNDS) {
        this.error("Fixpoint Error", "Evaluation failed to fixpoint");
      }
      perf.fixpoint(evaluation.start);
      // console.log("TOTAL ROUNDS", changes.round, perf.time(start));
      // console.log(changes);
      for(let database of this.databases) {
        database.onFixpoint(this, changes);
      }
      if(evaluation.callback) {
        evaluation.callback(changes);
      }
      this.currentEvaluation = undefined;
    }
  }

  onRemoteChanges(info) {
    let evaluation = this.currentEvaluation;
    let {blockId} = info;
    if(evaluation.waitingFor[blockId]) {
      evaluation.changes.mergeRound(info.changes);
      evaluation.waitingCount--;
      if(evaluation.waitingCount === 0) {
        let commit = evaluation.changes.commit();
        let blocks = this.blocksFromCommit(commit);
        this._fixpointRound(evaluation, blocks);
      }
      evaluation.waitingFor[blockId] = false;
    } else {
      throw new Error("Got a remote block execution for a block we're not waiting for");
    }
  }

  fixpoint(changes = new Changes(this.multiIndex), blocks = this.getAllBlocks(), callback?: EvaluationCallback) {
    let start = this.perf.time() as number;
    this.currentEvaluation = {type: QueuedType.changes, changes, start, callback};
    changes.changed = true;
    this._fixpointRound(this.currentEvaluation, blocks);
  }

  save() {
    let results = {};
    for(let database of this.databases) {
      let name = this.databaseToName(database);
      let values = database.toTriples();
      for(let value of values) {
        let [e,a,v,n] = value;
        if(ids.isId(e)) value[0] = ids.parts(e);
        if(ids.isId(v)) value[2] = ids.parts(v);
      }
      results[name] = values;
    }
    return results;
  }

  load(dbs: Object) {
    let changes = this.createChanges();
    for(let databaseName of Object.keys(dbs)) {
      let facts = dbs[databaseName];
      let db = this.getDatabase(databaseName);
      let index = db.index;
      for(let fact of facts) {
        let [e,a,v,n] = fact;
        if(ids.isId(e)) e = ids.load(e);
        if(ids.isId(v)) v = ids.load(v);
        changes.store(databaseName,e,a,v,n);
      }
    }
    this.executeActions([], changes);
  }

  close() {
    for(let database of this.databases) {
      database.unregister(this);
    }
  }
}
