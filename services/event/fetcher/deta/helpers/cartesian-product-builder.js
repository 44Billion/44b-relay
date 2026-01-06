// Deta won't allow many IN ARRAY clauses easily
// so we need cartesian product to build the or query array
// Deta can't use OR/AND on key https://github.com/deta/cloud-docs/discussions/230
// (a=1 AND b=2) OR (c=3 AND d=4)
// => [{a:1, b:2}, {c:3, d:4}]
// (a=1 OR b=2) AND (c=3 OR d=4)
// => you can do [{A and C}, {B and C}, {A and D}, {B and D}]
class CartesianProductBuilder {
  static * run ({ sets, keyTransformerFn }) {
    yield * new this(keyTransformerFn).mergeSetQueries(sets)
  }

  constructor (keyTransformerFn = v => v) {
    this.keyTransformerFn = keyTransformerFn
  }

  // expects sets = [['kinds', ['U', 'a', 'b']], ['ids', [1, 2]], ['bale', ['0z', 'ss']]]
  * mergeSetQueries (sets) {
    if (sets.length === 0) return yield {}
    for (const query of this.getSetQueries(sets[0])) {
      if (!query) return yield {}
      for (const auxQuery of this.mergeSetQueries(sets.slice(1))) {
        yield { ...query, ...auxQuery }
      }
    }
  }

  * getSetQueries (set) {
    if (set.length === 0) return yield
    if (!set[0] || (set[1] || []).length === 0) return yield {}
    for (let i = 0; i < set[1].length; i++) {
      yield { [this.keyTransformerFn(set[0], set[i])]: set[1][i] }
    }
  }
}

export default CartesianProductBuilder
