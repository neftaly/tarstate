(ns tarstate.relic-cljs
  (:require
   [clojure.string :as str]
   [com.wotbrew.relic :as rel]
   [goog.object :as gobj]))

(def ^:private db-slot "__tarstateRelicDb")

(defn- wrapped-db? [value]
  (some? (gobj/get value db-slot nil)))

(defn- wrap-db [db]
  (let [handle #js {:kind "relicCljsDb"}]
    (js/Object.defineProperty
     handle
     db-slot
     #js {:value db
          :enumerable false
          :writable false
          :configurable false})
    handle))

(defn- unwrap-db [value]
  (if (wrapped-db? value)
    (gobj/get value db-slot)
    value))

(defn- keyword-token [value]
  (if (and (string? value) (str/starts-with? value ":"))
    (keyword (subs value 1))
    value))

(defn- relic-value [value]
  (letfn [(convert [input]
            (cond
              (string? input)
              (keyword-token input)

              (map? input)
              (into {} (map (fn [[k v]]
                              [(if (string? k) (keyword k) k) (convert v)]))
                    input)

              (vector? input)
              (mapv convert input)

              (seq? input)
              (doall (map convert input))

              (set? input)
              (set (map convert input))

              :else
              input))]
    (convert (js->clj value))))

(defn- js-query-change [[query change]]
  {:query query
   :added (vec (:added change))
   :deleted (vec (:deleted change))})

(defn create-db
  ([] (wrap-db {}))
  ([seed] (wrap-db (relic-value seed))))

(defn snapshot [db]
  (clj->js (unwrap-db db)))

(defn q [db query]
  (clj->js (vec (rel/q (unwrap-db db) (relic-value query)))))

(defn transact [db tx]
  (wrap-db (rel/transact (unwrap-db db) (relic-value tx))))

(defn track-transact [db tx]
  (let [result (rel/track-transact (unwrap-db db) (relic-value tx))]
    #js {:db (wrap-db (:db result))
         :changes (clj->js (mapv js-query-change (:changes result)))}))

(defn mat [db query]
  (wrap-db (rel/mat (unwrap-db db) (relic-value query))))

(defn watch [db query]
  (wrap-db (rel/watch (unwrap-db db) (relic-value query))))

(defn unwatch [db query]
  (wrap-db (rel/unwatch (unwrap-db db) (relic-value query))))
