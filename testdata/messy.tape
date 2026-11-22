

// messy: every rule broken once
type   Order{Order( id :Int,state:View )}
type Qty = Int where self>=1 and self<=10



fn   total( o :Order , n:Int )->Int{
let a=-n+o.id*2
    let b = a |>double|> add( more : - 1 )

  match o{
      Order(id,state:"done")if id>0->b
    whole=Order( state : "x" ) -> whole.id   // the whole order
_->0-1
  }

}
fn double(n:Int)->Int{ n*2 }
fn add(n: Int, more: Int) -> Int {
  n + more
}
migration 1 "t" {
   CREATE TABLE t(a  INTEGER)   -- kept as written
}
fn map2[A,B](list:List[A],by:Fn[A,B])->List[B]{
  map(list, by: fn( x:A )->B{ by(x) } )
}
