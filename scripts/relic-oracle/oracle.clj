(ns relic-oracle
  (:require [com.wotbrew.relic :as rel])
  (:import [java.io Writer]))

(def accounts
  [{:id "cash" :name "Cash" :kind "asset"}
   {:id "sales" :name "Sales" :kind "income"}
   {:id "fees" :name "Bank fees" :kind "expense"}
   {:id "equity" :name "Owner equity" :kind "equity"}])

(def entries
  [{:id "e1" :accountId "cash" :amount 120 :memo "invoice paid" :posted true}
   {:id "e2" :accountId "sales" :amount -120 :memo "invoice paid" :posted true}
   {:id "e3" :accountId "fees" :amount -5 :memo nil :posted true}
   {:id "e4" :accountId "cash" :amount 0 :posted false}])

(def db
  (rel/transact {}
                (into [:insert :accounts] accounts)
                (into [:insert :entries] entries)))

(defn q-sorted [db query sort-key]
  (->> (or (rel/q db query) [])
       (sort-by sort-key)
       vec))

(defn sorted-by-id [rows]
  (vec (sort-by :id rows)))

(defn with-left-entry-id [rows]
  (mapv #(if (contains? % :entryId) % (assoc % :entryId nil)) rows))

(def simple-projection
  (q-sorted db
            [[:from :entries]
             [:where [> :amount 0]]
             [:select :id :amount]]
            :id))

(def joined-entry-accounts
  (q-sorted db
            [[:from :entries]
             [:extend [:entryId :id]]
             [:without :id]
             [:join :accounts {:accountId :id}]
             [:select :entryId [:accountName :name] :amount]]
            :entryId))

(def left-joined-account-entries
  (-> (q-sorted db
                [[:from :accounts]
                 [:left-join [[:from :entries]
                              [:extend [:entryId :id]]
                              [:without :id]]
                  {:id :accountId}]
                 [:select [:accountId :id] [:accountName :name] :entryId]]
                (juxt :accountId #(or (:entryId %) "")))
      with-left-entry-id))

(def aggregate-summary
  (q-sorted db
            [[:from :entries]
             [:agg [:accountId]
              [:entryCount [count]]
              [:total [rel/sum :amount]]
              [:average [rel/avg :amount]]]]
            :accountId))

(def set-left [[:const #{{:id "a"} {:id "b"}}]])
(def set-right [[:const #{{:id "b"} {:id "c"}}]])

(def transaction-entries
  (let [next-db (rel/transact db
                              [:insert :entries {:id "e5" :accountId "cash" :amount 15 :posted true}]
                              [:update :entries {:amount 125} [= :id "e1"]]
                              [:delete :entries [= :id "e2"]])]
    (q-sorted next-db
              [[:from :entries]
               [:select :id :accountId :amount :posted]]
              :id)))

(def cases
  {:simpleProjection simple-projection
   :join joined-entry-accounts
   :leftJoin left-joined-account-entries
   :aggregate aggregate-summary
   :setUnion (q-sorted {} [[:from set-left] [:union set-right]] :id)
   :setIntersection (q-sorted {} [[:from set-left] [:intersection set-right]] :id)
   :setDifference (q-sorted {} [[:from set-left] [:difference set-right]] :id)
   :transaction transaction-entries})

(defn json-escape [s]
  (let [sb (StringBuilder.)]
    (doseq [ch s]
      (case ch
        \" (.append sb "\\\"")
        \\ (.append sb "\\\\")
        \backspace (.append sb "\\b")
        \formfeed (.append sb "\\f")
        \newline (.append sb "\\n")
        \return (.append sb "\\r")
        \tab (.append sb "\\t")
        (.append sb ch)))
    (str sb)))

(declare write-json)

(defn write-json-array [^Writer writer values]
  (.write writer "[")
  (doseq [[index value] (map-indexed vector values)]
    (when (pos? index) (.write writer ","))
    (write-json writer value))
  (.write writer "]"))

(defn write-json-object [^Writer writer m]
  (.write writer "{")
  (doseq [[index [k value]] (map-indexed vector (sort-by (comp name key) m))]
    (when (pos? index) (.write writer ","))
    (write-json writer (name k))
    (.write writer ":")
    (write-json writer value))
  (.write writer "}"))

(defn write-json [^Writer writer value]
  (cond
    (nil? value) (.write writer "null")
    (true? value) (.write writer "true")
    (false? value) (.write writer "false")
    (number? value) (.write writer (str value))
    (keyword? value) (write-json writer (name value))
    (string? value) (do (.write writer "\"") (.write writer (json-escape value)) (.write writer "\""))
    (map? value) (write-json-object writer value)
    (sequential? value) (write-json-array writer value)
    (set? value) (write-json-array writer (sort-by pr-str value))
    :else (throw (ex-info "Unsupported JSON value" {:value value :class (class value)}))))

(write-json *out* cases)
(.write *out* "\n")
