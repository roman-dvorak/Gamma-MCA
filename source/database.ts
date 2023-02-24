import { indexedDB } from "std:lib/indexeddb";

export class database{

    private data_db = null;
    private meta_db = null;

    async connect(){
        this.data_db = indexedDB.open("myDatabase", 1);

        this.data_db.onsuccess = function(event) {
            let db = event.target.result;
            let objectStore = db.createObjectStore("data", { autoIncrement: true });

            let transaction = db.transaction("data", "readwrite");
            let objectStore = transaction.objectStore("data");
            let addRequest = objectStore.add({'datetime': 0, 'loc': {'lat': 0, 'lon':0, 'alt':0, 'src':'gps'}, 'spectrum': [0, 0, 0, 4, 0, 43, 0, 0, 43, 43]});

            console.log("Database opened successfully");

        // Use the database...
        };

        // Handle database open error
        //this.data_db.onerror = function(event) {
        //    console.error("Failed to open database:", event.target.error);
        //};

        // Handle database upgrade needed
        //this.data_db.onupgradeneeded = function(event) {
        //    let db = event.target.result;
        //    console.log("Upgrading database...");
//
        };
    }

    async insert_data(){


    }

    async create_db() {


    }
}


